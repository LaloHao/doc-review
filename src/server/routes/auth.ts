// Signing in: the owner's login form (token → session), invitation links
// (secret → session → clean URL), logging out.
//
// A link belongs to one invitation (a person × a document), so it can be
// rotated or revoked without touching the person's other documents. A reviewer
// session belongs to the person: opening any of their links signs them in and
// shows all their documents; opening another of their links in the same
// browser adds it to the session. The session remembers the links it was opened
// with: rotating a link ends the sessions opened with it, and a session whose
// links are all revoked ends too.

import { translator } from "../../i18n/index.js";
import type { App, Ctx } from "../context.js";
import { OWNER_TTL, PRE_COOKIE, REVIEWER_TTL, SESSION_COOKIE } from "../context.js";
import { newSecret, safeEqual } from "../crypto.js";
import { cookie, html, HttpError, parseCookies, readForm, redirect } from "../http.js";
import { messagePage } from "../pages/layout.js";
import { loginPage, switchIdentityPage } from "../pages/reviewer.js";
import { ipBucket } from "../ratelimit.js";
import type { Router } from "../router.js";

/** Paths are logged without link secrets. */
export function loggablePath(pathname: string): string {
  return pathname.startsWith("/a/") ? "/a/[hidden]" : pathname.slice(0, 200);
}

export function authRoutes(r: Router<Ctx>, app: App): void {
  const { repo, log } = app;

  // Open a link: create (or extend) the session, then leave the secret URL
  // behind. If this browser has a session of someone else, ask first (a link
  // opened by mistake, or sent by someone else, shouldn't silently switch
  // identities).
  const enter = async (c: Ctx, secret: string, confirmed: boolean) => {
    app.limited(app.limits.link, ipBucket(c.ip));
    // The page's own URL holds the secret: never send it as a referrer.
    c.res.setHeader("referrer-policy", "no-referrer");
    const found = await repo.invitationByLink(secret);
    const tr = translator(found?.document.language ?? c.lang);
    if (!found) return html(c.res, 404, messagePage(tr, tr("link.invalid_title"), tr("link.invalid")));
    const { invitation, person, document } = found;
    const target = `/d/${document.slug}`;
    if (c.session?.kind === "reviewer" && c.session.person?.id === person.id) {
      await repo.addSessionInvitation(c.session.idHash, invitation.id);
      return redirect(c.res, target);
    }
    if (c.session) {
      if (!confirmed) return html(c.res, 200, switchIdentityPage(tr, app.whoName(c.session), person.name, secret, c.session.csrf));
      await repo.deleteSession(c.session.idHash);
    }
    const s = await repo.createSession("reviewer", person.id, REVIEWER_TTL, invitation.id);
    log(`reviewer session created for person #${person.id} (invitation #${invitation.id})`);
    redirect(c.res, target, { "set-cookie": cookie(SESSION_COOKIE, s.id, REVIEWER_TTL / 1000) });
  };

  r.get("/a/:secret", async (c) => enter(c, c.params[0]!, false));

  r.post("/a", async (c) => {
    const form = await readForm(c.req);
    if (c.session) app.checkCsrf(c, form.get("_csrf") ?? "");
    else if (!app.sameOrigin(c)) throw new HttpError(403, "err.origin");
    await enter(c, form.get("secret") ?? "", true);
  });

  r.get("/login", async (c) => {
    if (c.session?.kind === "owner") return redirect(c.res, "/");
    const pre = newSecret(24);
    html(c.res, 200, loginPage(translator(c.lang), pre), { "set-cookie": cookie(PRE_COOKIE, pre, 3600) });
  });

  r.post("/login", async (c) => {
    app.limited(app.limits.login, ipBucket(c.ip));
    if (!app.sameOrigin(c)) throw new HttpError(403, "err.origin");
    const form = await readForm(c.req);
    const pre = parseCookies(c.req.headers.cookie).get(PRE_COOKIE) ?? "";
    if (!pre || !safeEqual(form.get("_csrf") ?? "", pre)) throw new HttpError(403, "err.form_expired");
    const cred = await app.ownerCredential((form.get("token") ?? "").trim());
    if (!cred) {
      log(`owner login failed from ${c.ip}`);
      const fresh = newSecret(24);
      const tr = translator(c.lang);
      return html(c.res, 401, loginPage(tr, fresh, tr("login.wrong")), { "set-cookie": cookie(PRE_COOKIE, fresh, 3600) });
    }
    if (c.session) await repo.deleteSession(c.session.idHash);
    const s = await repo.createSession("owner", null, OWNER_TTL, undefined, cred);
    log(`owner session created (${cred.deviceId === null ? "bootstrap token" : `device #${cred.deviceId}`})`);
    redirect(c.res, "/", { "set-cookie": [cookie(SESSION_COOKIE, s.id, OWNER_TTL / 1000), cookie(PRE_COOKIE, "", 0)] });
  });

  r.post("/logout", async (c) => {
    if (c.session) {
      const form = await readForm(c.req);
      app.checkCsrf(c, form.get("_csrf") ?? "");
      await repo.deleteSession(c.session.idHash);
    }
    redirect(c.res, "/", { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  });
}
