// The owner's devices: besides the bootstrap token (OWNER_TOKEN_SHA256), each
// computer can have its own owner token, revocable on its own. A new computer
// gets one with a short-lived enrollment code made by an owner device:
//
//   POST /api/devices/enroll-codes {name}   (owner)  → {code, expires_at, …}
//   POST /api/devices/enroll {code, name?}  (public) → {token, name, url}, once
//
// The enrollment endpoint reads no cookie and sets none; requests from a
// browser on another site are refused, every attempt is rate-limited (per IP
// and globally), and each code dies on first use, after 10 minutes, or after 5
// wrong attempts. Codes and tokens are stored as SHA-256; nothing secret is
// logged.

import { translator, type Tr } from "../../i18n/index.js";
import type { OwnerDevice } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { SESSION_COOKIE } from "../context.js";
import { newEnrollCode, normalizeEnrollCode, sha256Hex } from "../crypto.js";
import { cookie, html, HttpError, json, readJson } from "../http.js";
import { devicesPage } from "../pages/owner.js";
import { ipBucket } from "../ratelimit.js";
import type { Router } from "../router.js";
import { line, toInt } from "../validate.js";

export const ENROLL_CODE_TTL_MS = 10 * 60_000;
export const MAX_ACTIVE_CODES = 5;
export const MAX_CODE_ATTEMPTS = 5;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export const deviceJson = (d: OwnerDevice, currentId: number | null | undefined) => ({
  id: d.id,
  name: d.name,
  bootstrap: false,
  active: d.revoked_at === null,
  current: currentId === d.id,
  created_at: iso(d.created_at),
  last_used_at: iso(d.last_used_at),
  revoked_at: iso(d.revoked_at),
  created_from: d.created_from,
});

/** The bootstrap token as a device of the list: it can't be revoked here (it lives in the server's Secret). */
const bootstrapJson = (tr: Tr, currentId: number | null | undefined) => ({
  id: null,
  name: tr("devices.bootstrap_name"),
  bootstrap: true,
  active: true,
  current: currentId === null,
  created_at: null,
  last_used_at: null,
  revoked_at: null,
  created_from: null,
});

/** How to use a code on the new computer: the CLI, Emacs, or plain curl. */
export function enrollCommands(url: string, code: string) {
  return {
    cli: `doc-review enroll ${code} --url ${url}`,
    emacs: "M-x doc-review-enroll",
    curl: `curl -sS -X POST ${url}/api/devices/enroll -H 'content-type: application/json' -d '{"code":"${code}"}'`,
  };
}

/** Who did it, for the logs: "bootstrap" or "device #3". */
const who = (deviceId: number | null | undefined) => (deviceId === null || deviceId === undefined ? "bootstrap" : `device #${deviceId}`);

export function deviceRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, log } = app;

  r.get("/devices", async (c) => {
    app.requireOwner(c);
    const tr = translator(c.lang);
    html(
      c.res,
      200,
      devicesPage(app.layout(c, tr, tr("devices.title")), {
        devices: await repo.listDevices(),
        current: c.session!.deviceId,
        url: config.publicUrl,
        maxCodes: MAX_ACTIVE_CODES,
        minutes: ENROLL_CODE_TTL_MS / 60_000,
      }),
    );
  });

  r.get("/api/devices", async (c) => {
    app.requireOwner(c);
    const tr = translator(c.lang);
    const current = c.session!.deviceId;
    json(c.res, 200, { devices: [bootstrapJson(tr, current), ...(await repo.listDevices()).map((d) => deviceJson(d, current))] });
  });

  r.post("/api/devices/enroll-codes", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = await readJson(c.req);
    const name = line(b.name, "field.device_name", 100, { required: true });
    // (Two simultaneous requests could make a sixth code: harmless.)
    if ((await repo.activeEnrollCodes(MAX_CODE_ATTEMPTS)) >= MAX_ACTIVE_CODES) {
      throw new HttpError(409, "err.too_many_codes", { max: MAX_ACTIVE_CODES });
    }
    const code = newEnrollCode();
    const by = c.session!.deviceId;
    const expires = await repo.createEnrollCode(sha256Hex(normalizeEnrollCode(code)!), name, by === null || by === undefined ? "bootstrap" : String(by), ENROLL_CODE_TTL_MS);
    log(`enrollment code created by ${who(by)}, valid until ${expires.toISOString()}`);
    json(c.res, 201, {
      code,
      name,
      expires_at: expires.toISOString(),
      expires_in: Math.round(ENROLL_CODE_TTL_MS / 1000),
      url: config.publicUrl,
      commands: enrollCommands(config.publicUrl, code),
    });
  });

  r.post("/api/devices/enroll", async (c) => {
    // No cookie is involved, so CSRF doesn't apply; still, a page on another
    // site must not be able to drive this from a visitor's browser.
    const origin = c.req.headers.origin;
    const site = c.req.headers["sec-fetch-site"];
    if ((origin !== undefined && origin !== config.origin) || (site !== undefined && site !== "same-origin")) {
      throw new HttpError(403, "err.origin");
    }
    app.limited(app.limits.enroll, ipBucket(c.ip));
    app.limited(app.limits.enrollGlobal, "enroll");
    const b = await readJson(c.req, 4096);
    const name = typeof b.name === "string" && b.name.trim() !== "" ? line(b.name, "field.device_name", 100) : null;
    const code = normalizeEnrollCode(b.code);
    // A malformed code goes through the same lookup (and counts as a wrong attempt).
    const done = config.ownerTokenSha256 ? await repo.redeemEnrollCode(sha256Hex(code ?? "-"), name, MAX_CODE_ATTEMPTS) : null;
    if (!done) {
      log(`device enrollment failed from ${c.ip}`);
      throw new HttpError(400, "err.enroll_code");
    }
    log(`device #${done.device.id} enrolled from ${c.ip} (code made by ${done.createdBy === "bootstrap" ? "bootstrap" : `device #${done.createdBy}`})`);
    json(c.res, 201, { token: done.token, name: done.device.name, url: config.publicUrl, device: deviceJson(done.device, done.device.id) });
  });

  r.post("/api/devices/:id/revoke", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    if (c.params[0] === "bootstrap") throw new HttpError(409, "err.bootstrap_revoke");
    const id = toInt(c.params[0]);
    const done = await repo.revokeDevice(id);
    if (!done) throw new HttpError(404, "err.no_device");
    const by = c.session!.deviceId;
    log(`device #${id} revoked by ${who(by)}: ${done.sessions} session(s) closed`);
    // A browser that revoked its own device just lost its session.
    const self = !c.bearer && by === id;
    json(c.res, 200, { device: deviceJson(done.device, by), sessions_closed: done.sessions }, self ? { "set-cookie": cookie(SESSION_COOKIE, "", 0) } : {});
  });
}
