// Who am I; a reviewer's own notification preferences (a plain form that
// works without JavaScript); the owner's channels and "close all sessions".

import { reviewerDigestHour } from "../../config.js";
import { translator } from "../../i18n/index.js";
import type { App, Ctx } from "../context.js";
import { SESSION_COOKIE } from "../context.js";
import { cookie, html, HttpError, json, readForm, readJson, redirect } from "../http.js";
import { notificationsPage } from "../pages/reviewer.js";
import type { Router } from "../router.js";
import { replyNotify } from "../validate.js";

export function settingsRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, notifier, log } = app;

  r.get("/api/me", async (c) => {
    const v = app.viewerOf(c);
    const p = c.session!.person;
    json(c.res, 200, {
      kind: v.kind,
      name: app.whoName(c.session!),
      person_id: v.personId,
      csrf: c.bearer ? undefined : c.session!.csrf,
      notifications: p ? { replies: p.notify_replies, versions: p.notify_versions, email: p.email !== null } : undefined,
    });
  });

  r.get("/notifications", async (c) => {
    if (app.viewerOf(c).kind !== "reviewer") return redirect(c.res, "/");
    const p = c.session!.person!;
    const tr = translator(c.lang);
    html(
      c.res,
      200,
      notificationsPage(app.layout(c, tr, tr("notif.title")), {
        replies: p.notify_replies,
        versions: p.notify_versions,
        email: p.email,
        mailEnabled: notifier.enabled.reviewerEmail,
        digestTime: `${reviewerDigestHour(config)}:00`,
        saved: c.url.searchParams.get("saved") === "1",
        documents: await repo.invitationsOfPerson(p.id, { activeOnly: true }),
      }),
    );
  });

  r.post("/notifications", async (c) => {
    if (app.viewerOf(c).kind !== "reviewer") throw new HttpError(403, "err.reviewers_only");
    const form = await readForm(c.req);
    app.checkCsrf(c, form.get("_csrf") ?? "");
    await repo.updatePerson(c.session!.person!.id, {
      notify_replies: replyNotify(form.get("replies")),
      notify_versions: form.get("versions") === "1",
    });
    redirect(c.res, "/notifications?saved=1");
  });

  r.post("/api/sessions/close-all", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = c.req.headers["content-type"]?.startsWith("application/json") ? await readJson(c.req) : {};
    const closed = await repo.closeAllSessions(b.reviewers === true);
    log(`sessions closed by the owner: ${closed.owner} owner, ${closed.reviewers} reviewer`);
    json(c.res, 200, { closed }, c.bearer ? {} : { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  });

  r.get("/api/settings", async (c) => {
    app.requireOwner(c);
    json(c.res, 200, { notifications: notifier.enabled, digest_hour: config.digestHour, time_zone: config.timeZone });
  });
}
