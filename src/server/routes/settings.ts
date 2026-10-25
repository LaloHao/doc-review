// Settings: the owner's (visibility, sessions) and a director's own
// notification preferences page; who am I.

import { directorDigestHour } from "../../config.js";
import type { Visibility } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { SESSION_COOKIE } from "../context.js";
import { cookie, html, HttpError, json, readForm, readJson, redirect } from "../http.js";
import * as pages from "../pages.js";
import type { Router } from "../router.js";
import { replyNotify } from "../validate.js";

export function settingsRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, notifier, log } = app;

  r.get("/api/me", async (c) => {
    const v = app.requireAny(c);
    const d = c.session!.director;
    json(c.res, 200, {
      kind: v.kind,
      name: app.whoName(c.session!),
      director_id: v.directorId,
      csrf: c.bearer ? undefined : c.session!.csrf,
      notifications: d ? { replies: d.notify_replies, versions: d.notify_versions, email: d.email !== null } : undefined,
    });
  });

  // A director's own notification settings (a plain form: works without JS).
  const notificationsPage = (c: Ctx, saved: boolean) => {
    const d = c.session!.director!;
    return pages.notificationsPage(app.layout(c, "Notificaciones"), {
      replies: d.notify_replies,
      versions: d.notify_versions,
      email: d.email,
      mailEnabled: notifier.enabled.directorEmail,
      digestTime: `${directorDigestHour(config)}:00`,
      saved,
    });
  };

  r.get("/notificaciones", async (c) => {
    if (app.requireAny(c).kind !== "director") return redirect(c.res, "/");
    html(c.res, 200, notificationsPage(c, c.url.searchParams.get("guardado") === "1"));
  });

  r.post("/notificaciones", async (c) => {
    if (app.requireAny(c).kind !== "director") throw new HttpError(403, "Solo para directores.");
    const form = await readForm(c.req);
    app.checkCsrf(c, form.get("_csrf") ?? "");
    await repo.updateDirector(c.session!.director!.id, {
      notify_replies: replyNotify(form.get("replies")),
      notify_versions: form.get("versions") === "1",
    });
    redirect(c.res, "/notificaciones?guardado=1");
  });

  r.post("/api/sessions/close-all", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = c.req.headers["content-type"]?.startsWith("application/json") ? await readJson(c.req) : {};
    const closed = await repo.closeAllSessions(b.directors === true);
    log(`sessions closed by the owner: ${closed.owner} owner, ${closed.directors} director`);
    json(c.res, 200, { closed }, c.bearer ? {} : { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  });

  r.get("/api/settings", async (c) => {
    app.requireOwner(c);
    json(c.res, 200, { settings: { comments_visibility: await repo.visibility() }, notifications: notifier.enabled });
  });

  r.put("/api/settings", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = await readJson(c.req);
    if (b.comments_visibility !== undefined) {
      if (b.comments_visibility !== "all" && b.comments_visibility !== "own") throw new HttpError(400, "comments_visibility: all u own.");
      await repo.setSetting("comments_visibility", b.comments_visibility as Visibility);
    }
    json(c.res, 200, { settings: { comments_visibility: await repo.visibility() } });
  });
}
