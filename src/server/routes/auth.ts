// Signing in: the owner's login form (token → session), director links
// (secret → session → clean URL), logging out.

import type { App, Ctx } from "../context.js";
import { DIRECTOR_TTL, OWNER_TTL, PRE_COOKIE, SESSION_COOKIE } from "../context.js";
import { newSecret, safeEqual } from "../crypto.js";
import { cookie, html, HttpError, parseCookies, readForm, redirect } from "../http.js";
import * as pages from "../pages.js";
import { ipBucket } from "../ratelimit.js";
import type { Router } from "../router.js";

/** Paths are logged without director link secrets. */
export function loggablePath(pathname: string): string {
  return pathname.startsWith("/acceso/") ? "/acceso/[oculto]" : pathname.slice(0, 200);
}

export function authRoutes(r: Router<Ctx>, app: App): void {
  const { repo, log } = app;

  // Director link: create a session, then leave the secret URL behind. If this
  // browser already has a session of someone else, ask first (a link opened by
  // mistake, or sent by someone else, shouldn't silently switch identities).
  const enterAsDirector = async (c: Ctx, secret: string, confirmed: boolean) => {
    app.limited(app.limits.link, ipBucket(c.ip));
    // The page's own URL holds the secret: never send it as a referrer.
    c.res.setHeader("referrer-policy", "no-referrer");
    const director = await repo.directorByLink(secret);
    if (!director) {
      return html(c.res, 404, pages.messagePage("Enlace no válido", "Este enlace no es válido o fue revocado. Pida un enlace nuevo al autor de la tesis."));
    }
    if (c.session) {
      if (c.session.kind === "director" && c.session.director?.id === director.id) return redirect(c.res, "/");
      if (!confirmed) {
        return html(c.res, 200, pages.switchIdentityPage(app.whoName(c.session), director.name, secret, c.session.csrf));
      }
      await repo.deleteSession(c.session.idHash);
    }
    const s = await repo.createSession("director", director.id, DIRECTOR_TTL);
    log(`director session created for director #${director.id}`);
    redirect(c.res, "/", { "set-cookie": cookie(SESSION_COOKIE, s.id, DIRECTOR_TTL / 1000) });
  };

  r.get("/acceso/:secret", async (c) => enterAsDirector(c, c.params[0]!, false));

  r.post("/acceso", async (c) => {
    const form = await readForm(c.req);
    if (c.session) app.checkCsrf(c, form.get("_csrf") ?? "");
    else if (!app.sameOrigin(c)) throw new HttpError(403, "Origen no permitido.");
    await enterAsDirector(c, form.get("secret") ?? "", true);
  });

  r.get("/entrar", async (c) => {
    if (c.session?.kind === "owner") return redirect(c.res, "/");
    const pre = newSecret(24);
    html(c.res, 200, pages.loginPage(pre), { "set-cookie": cookie(PRE_COOKIE, pre, 3600) });
  });

  r.post("/entrar", async (c) => {
    app.limited(app.limits.login, ipBucket(c.ip));
    if (!app.sameOrigin(c)) throw new HttpError(403, "Origen no permitido.");
    const form = await readForm(c.req);
    const pre = parseCookies(c.req.headers.cookie).get(PRE_COOKIE) ?? "";
    if (!pre || !safeEqual(form.get("_csrf") ?? "", pre)) throw new HttpError(403, "Formulario caducado. Vuelva a cargar la página.");
    if (!app.ownerTokenOk(form.get("token") ?? "")) {
      log(`owner login failed from ${c.ip}`);
      const fresh = newSecret(24);
      return html(c.res, 401, pages.loginPage(fresh, "Token incorrecto."), { "set-cookie": cookie(PRE_COOKIE, fresh, 3600) });
    }
    if (c.session) await repo.deleteSession(c.session.idHash);
    const s = await repo.createSession("owner", null, OWNER_TTL);
    log("owner session created");
    redirect(c.res, "/", {
      "set-cookie": [cookie(SESSION_COOKIE, s.id, OWNER_TTL / 1000), cookie(PRE_COOKIE, "", 0)],
    });
  });

  r.post("/salir", async (c) => {
    if (c.session) {
      const form = await readForm(c.req);
      app.checkCsrf(c, form.get("_csrf") ?? "");
      await repo.deleteSession(c.session.idHash);
    }
    redirect(c.res, "/", { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  });
}
