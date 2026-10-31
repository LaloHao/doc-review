// Owner devices and enrollment codes: the migration, device tokens on the API
// and the web, revocation, the public enrollment endpoint and its limits, the
// devices page, and the CLI's enroll (config file written 0600).

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkConfigWritable, Client, enrollDevice, loadClientConfig, saveClientConfig } from "../src/client.js";
import { migrate, openDb, pendingMigrations } from "../src/db/db.js";
import { ownerSessionFingerprint, Repo } from "../src/repo.js";
import { CROCKFORD, newEnrollCode, normalizeEnrollCode, sha256Hex } from "../src/server/crypto.js";
import { Browser, ORIGIN, OWNER_TOKEN, startTestServer, type TestServer } from "./helpers.js";

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

type CodeReply = { code: string; name: string; expires_at: string; expires_in: number; url: string; commands: { cli: string; emacs: string; curl: string } };
type DeviceJson = { id: number | null; name: string; bootstrap: boolean; active: boolean; current: boolean; last_used_at: string | null; created_from: string | null };

async function makeCode(s: TestServer, name = "MacBook", token = OWNER_TOKEN): Promise<CodeReply> {
  const res = await fetch(s.url + "/api/devices/enroll-codes", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CodeReply;
}

function enroll(s: TestServer, body: unknown, headers: Record<string, string> = {}) {
  return fetch(s.url + "/api/devices/enroll", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function enrolled(s: TestServer, code: string, name?: string): Promise<{ token: string; name: string; url: string; device: DeviceJson }> {
  const res = await enroll(s, { code, ...(name ? { name } : {}) });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; name: string; url: string; device: DeviceJson };
}

const bearer = (s: TestServer, token: string, path: string, init: RequestInit = {}) =>
  fetch(s.url + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

async function webLogin(s: TestServer, token: string): Promise<Browser> {
  const f = await fetch(s.url + "/login");
  const pre = f.headers.getSetCookie()[0]!.split(";")[0]!;
  const res = await fetch(s.url + "/login", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: pre, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: pre.split("=")[1]!, token }).toString(),
  });
  expect(res.status).toBe(303);
  const b = new Browser(s.url);
  b.cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-dr_session="))!.split(";")[0]!;
  await b.login();
  return b;
}

describe("migration 003_owner_devices", () => {
  it("creates owner_devices, enroll_codes and the sessions' device column, once", async () => {
    const db = await openDb("pglite:memory");
    try {
      expect(await pendingMigrations(db)).toContain("003_owner_devices");
      expect(await migrate(db)).toContain("003_owner_devices");
      expect(await migrate(db)).toEqual([]);
      const cols = async (t: string) =>
        (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = $1 order by column_name", [t])).map((r) => r.column_name);
      expect(await cols("owner_devices")).toEqual(["created_at", "created_from", "id", "last_used_at", "name", "revoked_at", "token_hash"]);
      expect(await cols("enroll_codes")).toEqual(["attempts", "code_hash", "created_at", "created_by_device", "device_name", "expires_at", "id", "used_at"]);
      expect(await cols("sessions")).toContain("owner_device_id");
    } finally {
      await db.close();
    }
  });
});

describe("enrollment codes", () => {
  it("are Crockford base32, 10 characters (50 bits) in two groups, and forgiving when typed", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = newEnrollCode();
      expect(c).toMatch(CODE_RE);
      seen.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(CROCKFORD).toHaveLength(32);
    expect(Math.log2(CROCKFORD.length) * 10).toBeGreaterThanOrEqual(40);
    expect(normalizeEnrollCode("k7q2x-9xmpa")).toBe("K7Q2X9XMPA");
    expect(normalizeEnrollCode(" K7Q2X 9XMPA ")).toBe("K7Q2X9XMPA");
    expect(normalizeEnrollCode("ilo00-11111")).toBe("11000" + "11111");
    expect(normalizeEnrollCode("K7Q2X-9XMPU")).toBeNull(); // U is not in the alphabet
    expect(normalizeEnrollCode("K7Q2X-9XMP")).toBeNull();
    expect(normalizeEnrollCode(42)).toBeNull();
    expect(normalizeEnrollCode("A".repeat(100))).toBeNull();
  });
});

describe("devices", () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer();
  });
  afterAll(async () => {
    await s.stop();
  });

  it("a code is stored hashed, works once, and gives a device token that is a full owner credential", async () => {
    const c = await makeCode(s, "MacBook de viaje");
    expect(c.code).toMatch(CODE_RE);
    expect(c.expires_in).toBe(600);
    expect(Date.parse(c.expires_at) - Date.now()).toBeGreaterThan(590_000);
    expect(c.url).toBe(ORIGIN);
    expect(c.commands.cli).toBe(`doc-review enroll ${c.code} --url ${ORIGIN}`);
    expect(c.commands.curl).toContain(`${ORIGIN}/api/devices/enroll`);
    const rows = await s.repo.db.query<{ code_hash: string; device_name: string; created_by_device: string }>("select code_hash, device_name, created_by_device from enroll_codes");
    expect(rows).toEqual([{ code_hash: sha256Hex(normalizeEnrollCode(c.code)!), device_name: "MacBook de viaje", created_by_device: "bootstrap" }]);

    // Typed in lowercase without the hyphen: the same code.
    const r = await enrolled(s, c.code.toLowerCase().replace("-", ""));
    expect(r.token).toMatch(/^dr_owner_[A-Za-z0-9_-]{43}$/);
    expect(r.name).toBe("MacBook de viaje");
    expect(r.url).toBe(ORIGIN);
    expect(r.device.created_from).toBe("bootstrap");
    const [d] = await s.repo.db.query<{ token_hash: string }>("select token_hash from owner_devices");
    expect(d!.token_hash).toBe(sha256Hex(r.token));
    // Used: it doesn't work again.
    expect((await enroll(s, { code: c.code })).status).toBe(400);

    // The device token can do what the owner does, including making codes.
    expect((await bearer(s, r.token, "/api/documents")).status).toBe(200);
    const res = await bearer(s, r.token, "/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "from-mac", title: "From the Mac" }) });
    expect(res.status).toBe(201);
    const c2 = await makeCode(s, "Tablet", r.token);
    const r2 = await enrolled(s, c2.code, "iPad");
    expect(r2.name).toBe("iPad");
    expect(r2.device.created_from).toBe(String(r.device.id));

    const logs = s.logs.join("\n");
    for (const secret of [c.code, normalizeEnrollCode(c.code)!, r.token, c2.code, r2.token]) expect(logs).not.toContain(secret);
    expect(logs).toContain(`device #${r.device.id} enrolled`);
    expect(logs).toContain("enrollment code created by bootstrap");
    expect(logs).toContain(`enrollment code created by device #${r.device.id}`);
  });

  it("lists the bootstrap token first (localized, not revocable) and marks the current device", async () => {
    const all = await s.repo.listDevices();
    const mac = all.find((d) => d.name === "MacBook de viaje")!;
    const list = async (token: string, lang = "en") =>
      ((await (await bearer(s, token, "/api/devices", { headers: { "accept-language": lang } })).json()) as { devices: DeviceJson[] }).devices;
    const byBootstrap = await list(OWNER_TOKEN, "es");
    expect(byBootstrap[0]).toMatchObject({ id: null, bootstrap: true, name: "principal (OWNER_TOKEN_SHA256)", active: true, current: true });
    expect(byBootstrap.map((d) => d.name)).toEqual(["principal (OWNER_TOKEN_SHA256)", "MacBook de viaje", "iPad"]);
    expect((await list(OWNER_TOKEN))[0]!.name).toBe("main (OWNER_TOKEN_SHA256)");
    expect(byBootstrap[1]!.last_used_at).not.toBeNull();
    expect(byBootstrap[1]!.current).toBe(false);
    expect((await s.ownerJson("POST", "/api/devices/bootstrap/revoke", {})).status).toBe(409);
    expect((await s.ownerJson("POST", "/api/devices/999/revoke", {})).status).toBe(404);
    expect(mac.revoked_at).toBeNull();
  });

  it("last_used_at is written at most once a minute", async () => {
    const c = await makeCode(s, "Throttled");
    const r = await enrolled(s, c.code);
    const lastUsed = async () => {
      const [d] = await s.repo.db.query<{ last_used_at: Date | null }>("select last_used_at from owner_devices where id = $1", [r.device.id]);
      return d!.last_used_at ? new Date(d!.last_used_at).getTime() : null;
    };
    expect(await lastUsed()).toBeNull();
    const t0 = Date.now();
    try {
      s.repo.clock = () => t0;
      expect((await bearer(s, r.token, "/api/me")).status).toBe(200);
      expect(await lastUsed()).toBe(t0);
      s.repo.clock = () => t0 + 30_000;
      expect((await bearer(s, r.token, "/api/me")).status).toBe(200);
      expect(await lastUsed()).toBe(t0);
      s.repo.clock = () => t0 + 61_000;
      expect((await bearer(s, r.token, "/api/me")).status).toBe(200);
      expect(await lastUsed()).toBe(t0 + 61_000);
    } finally {
      s.repo.clock = Date.now;
    }
  });

  it("revoking a device refuses its token and ends its web sessions only", async () => {
    const c = await makeCode(s, "Lost laptop");
    const r = await enrolled(s, c.code);
    const deviceWeb = await webLogin(s, r.token);
    const bootstrapWeb = await webLogin(s, OWNER_TOKEN);
    expect((await deviceWeb.get("/api/me")).status).toBe(200);
    const page = await (await deviceWeb.get("/devices", { "accept-language": "en" })).text();
    expect(page).toContain("Lost laptop</strong> <span class=\"tag tag-done\">this device</span>");
    expect(s.logs.join("\n")).toContain(`owner session created (device #${r.device.id})`);

    const res = await s.ownerJson("POST", `/api/devices/${r.device.id}/revoke`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: DeviceJson; sessions_closed: number };
    expect(body.sessions_closed).toBe(1);
    expect(body.device.active).toBe(false);
    expect((await deviceWeb.get("/api/me")).status).toBe(401);
    expect((await bootstrapWeb.get("/api/me")).status).toBe(200);
    expect((await bearer(s, r.token, "/api/documents")).status).toBe(401);
    // Its token can't sign in on the web either.
    const f = await fetch(s.url + "/login");
    const pre = f.headers.getSetCookie()[0]!.split(";")[0]!;
    const login = await fetch(s.url + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { cookie: pre, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: pre.split("=")[1]!, token: r.token }).toString(),
    });
    expect(login.status).toBe(401);
    // Revoking again changes nothing.
    expect(((await (await s.ownerJson("POST", `/api/devices/${r.device.id}/revoke`, {})).json()) as { sessions_closed: number }).sessions_closed).toBe(0);
  });

  it("a browser that revokes its own device loses its session", async () => {
    const r = await enrolled(s, (await makeCode(s, "Self")).code);
    const b = await webLogin(s, r.token);
    const res = await b.send("POST", `/api/devices/${r.device.id}/revoke`, {});
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-dr_session=; .*Max-Age=0/);
    expect((await b.get("/api/me")).status).toBe(401);
  });

  it("rotating the bootstrap token ends bootstrap sessions, not device sessions; owner access off ends both", async () => {
    const r = await enrolled(s, (await makeCode(s, "Survivor")).code);
    const before = new Repo(s.repo.db, "x", ownerSessionFingerprint(sha256Hex(OWNER_TOKEN)));
    const after = new Repo(s.repo.db, "x", ownerSessionFingerprint(sha256Hex("dr_owner_rotated")));
    const off = new Repo(s.repo.db, "x", "");
    const fp = (await before.deviceFingerprint(r.device.id!))!;
    expect(fp).toBe(ownerSessionFingerprint(sha256Hex(r.token)));
    const boot = await before.createSession("owner", null, 3600_000);
    const dev = await before.createSession("owner", null, 3600_000, undefined, { deviceId: r.device.id, fp });
    expect((await before.getSession(dev.id, () => 3600_000))?.deviceId).toBe(r.device.id);
    expect(await after.purgeStaleOwnerSessions()).toBeGreaterThanOrEqual(1);
    expect(await after.getSession(boot.id, () => 3600_000)).toBeNull();
    expect((await after.getSession(dev.id, () => 3600_000))?.deviceId).toBe(r.device.id);
    // A session that claims a device with a wrong fingerprint is refused.
    const forged = await before.createSession("owner", null, 3600_000, undefined, { deviceId: r.device.id, fp: "0".repeat(32) });
    expect(await before.getSession(forged.id, () => 3600_000)).toBeNull();
    expect(await off.getSession(dev.id, () => 3600_000)).toBeNull();
  });

  it("at most 5 unused codes at a time", async () => {
    const fresh = await startTestServer();
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push(await makeCode(fresh, `D${i}`));
      const sixth = await fresh.ownerJson("POST", "/api/devices/enroll-codes", { name: "D5" });
      expect(sixth.status).toBe(409);
      expect(((await sixth.json()) as { error: string }).error).toContain("5 unused codes");
      await enrolled(fresh, codes[0]!.code);
      expect((await fresh.ownerJson("POST", "/api/devices/enroll-codes", { name: "D5" })).status).toBe(201);
      expect((await fresh.ownerJson("POST", "/api/devices/enroll-codes", {})).status).toBe(400);
      expect((await fresh.ownerJson("POST", "/api/devices/enroll-codes", { name: "x".repeat(101) })).status).toBe(400);
    } finally {
      await fresh.stop();
    }
  });

  it("a code expires after 10 minutes", async () => {
    const fresh = await startTestServer();
    try {
      const c = await makeCode(fresh);
      fresh.repo.clock = () => Date.now() + 10 * 60_000 + 1000;
      expect((await enroll(fresh, { code: c.code })).status).toBe(400);
      fresh.repo.clock = Date.now;
      // Still unused, and not expired by the server's own clock: it was refused only for the time.
      expect((await enroll(fresh, { code: c.code })).status).toBe(201);
    } finally {
      await fresh.stop();
    }
  });

  it("a code dies after 5 wrong attempts (any wrong code counts against every active one)", async () => {
    const fresh = await startTestServer();
    try {
      const c = await makeCode(fresh);
      const other = await makeCode(fresh, "Other");
      for (let i = 0; i < 4; i++) {
        const res = await enroll(fresh, { code: i % 2 ? "AAAAA-AAAAA" : "not a code" });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("Invalid, used or expired code.");
      }
      // Four wrong attempts: still alive.
      await enrolled(fresh, c.code);
      const [o] = await fresh.repo.db.query<{ attempts: number }>("select attempts from enroll_codes where device_name = 'Other'");
      expect(o!.attempts).toBe(4);
      expect((await enroll(fresh, { code: "BBBBB-BBBBB" })).status).toBe(400);
      // The fifth wrong attempt killed the other code.
      expect((await enroll(fresh, { code: other.code })).status).toBe(400);
      expect(await fresh.repo.activeEnrollCodes(5)).toBe(0);
      expect(fresh.logs.filter((l) => l.startsWith("device enrollment failed")).length).toBe(6);
    } finally {
      await fresh.stop();
    }
  });

  it("rate-limits enrollment per IP and for everyone", async () => {
    const fresh = await startTestServer({ TRUST_PROXY: "cloudflare" });
    try {
      const from = (ip: string) => enroll(fresh, { code: "AAAAA-AAAAA" }, { "cf-connecting-ip": ip });
      const one: number[] = [];
      for (let i = 0; i < 11; i++) one.push((await from("203.0.113.7")).status);
      expect(one.slice(0, 10).every((x) => x === 400)).toBe(true);
      expect(one[10]).toBe(429);
      // 10 from 203.0.113.7 so far; 20 more from other addresses reach the global limit.
      const many: number[] = [];
      for (let i = 0; i < 21; i++) many.push((await from(`198.51.100.${i + 1}`)).status);
      expect(many.slice(0, 20).every((x) => x === 400)).toBe(true);
      expect(many[20]).toBe(429);
    } finally {
      await fresh.stop();
    }
  });

  it("refuses requests from a browser on another site", async () => {
    const fresh = await startTestServer();
    try {
      const c = await makeCode(fresh);
      const refused: Record<string, string>[] = [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }];
      for (const h of refused) {
        expect((await enroll(fresh, { code: c.code }, h)).status, JSON.stringify(h)).toBe(403);
      }
      // A refused request doesn't count as an attempt; same-origin passes.
      expect((await enroll(fresh, { code: c.code }, { origin: ORIGIN, "sec-fetch-site": "same-origin" })).status).toBe(201);
    } finally {
      await fresh.stop();
    }
  });

  it("the devices page and API are the owner's; cookie mutations need the CSRF token", async () => {
    await s.createDoc("dev-doc");
    const { link } = await s.invite("dev-doc", { name: "Dr. R" });
    const reviewer = await s.browser(link);
    expect((await reviewer.get("/devices")).status).toBe(403);
    expect((await reviewer.get("/api/devices")).status).toBe(403);
    expect((await reviewer.send("POST", "/api/devices/enroll-codes", { name: "x" })).status).toBe(403);
    expect((await fetch(s.url + "/devices", { redirect: "manual" })).status).toBe(303);
    expect((await fetch(s.url + "/api/devices")).status).toBe(401);
    expect((await fetch(s.url + "/api/devices/enroll-codes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);

    const owner = await webLogin(s, OWNER_TOKEN);
    const html = await (await owner.get("/devices", { "accept-language": "es" })).text();
    expect(html).toContain("<h1>Dispositivos</h1>");
    expect(html).toContain("principal (OWNER_TOKEN_SHA256)");
    expect(html).toContain("Vincular un dispositivo nuevo");
    expect(html).toContain('id="enroll-form"');
    expect(html).toContain('data-action="revoke-device"');
    expect(html).toContain('href="/devices"');
    // No CSRF token, or another origin: refused.
    expect((await owner.send("POST", "/api/devices/enroll-codes", { name: "x" }, { "x-csrf-token": "" })).status).toBe(403);
    expect((await owner.send("POST", "/api/devices/enroll-codes", { name: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    const ok = await owner.send("POST", "/api/devices/enroll-codes", { name: "Via web" });
    expect(ok.status).toBe(201);
    const r = await enrolled(s, ((await ok.json()) as CodeReply).code);
    expect((await owner.send("POST", `/api/devices/${r.device.id}/revoke`, {}, { "x-csrf-token": "" })).status).toBe(403);
    expect((await owner.send("POST", `/api/devices/${r.device.id}/revoke`, {})).status).toBe(200);
  });
});

describe("enrolling from the command line", () => {
  let s: TestServer;
  let dir: string;
  beforeAll(async () => {
    s = await startTestServer();
    dir = await mkdtemp(join(tmpdir(), "dr-enroll-"));
  });
  afterAll(async () => {
    await s.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("redeems a code and writes config.json with mode 0600; the token then works", async () => {
    const path = join(dir, "new", "doc-review", "config.json");
    await checkConfigWritable(path, false);
    const c = await makeCode(s, "Mac");
    const r = await enrollDevice(s.url, c.code, "mac.local");
    expect(r.name).toBe("mac.local");
    await saveClientConfig(path, r.url, r.token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "new", "doc-review"))).mode & 0o777).toBe(0o700);
    const cfg = await loadClientConfig(path);
    expect(cfg).toEqual({ url: s.url, token: r.token });
    const { documents } = await new Client(cfg).request<{ documents: unknown[] }>("GET", "/api/documents");
    expect(Array.isArray(documents)).toBe(true);
    // A spent code: the server's message.
    await expect(enrollDevice(s.url, c.code, "again")).rejects.toThrow(/Invalid, used or expired code/);
  });

  it("refuses to replace a configured server unless forced, keeping the other keys", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ url: "https://old.example", token: "dr_owner_old", servers: { "https://x.example": "dr_owner_x" } }), { mode: 0o644 });
    await expect(checkConfigWritable(path, false)).rejects.toThrow(/already has a server and token .*--force/);
    await checkConfigWritable(path, true);
    await saveClientConfig(path, s.url, "dr_owner_new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      url: s.url,
      token: "dr_owner_new",
      servers: { "https://x.example": "dr_owner_x", "https://old.example": "dr_owner_old" },
    });
  });

  it("only over https (http only for this machine)", async () => {
    await expect(enrollDevice("http://review.example.com", "AAAAA-AAAAA", "x")).rejects.toThrow(/https/);
    const seen: string[] = [];
    const fake = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ error: "Invalid, used or expired code." }), { status: 400 });
    }) as typeof fetch;
    await expect(enrollDevice("https://review.example.com/", "AAAAA-AAAAA", "x", fake)).rejects.toThrow(/Invalid/);
    expect(seen).toEqual(["https://review.example.com/api/devices/enroll"]);
  });
});
