// Directors (owner only): create, edit, rotate and revoke their links.

import type { Director } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { HttpError, json, readJson } from "../http.js";
import type { Router } from "../router.js";
import { emailField, replyNotify, str, toInt } from "../validate.js";
import type { Repo } from "../../repo.js";

export function reviewerRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, notifier, log } = app;
  const directorJson = (d: Director) => ({ ...d, active: d.revoked_at === null });
  const linkOf = (secret: string) => `${config.publicUrl}/acceso/${secret}`;

  const maybeSendLink = async (d: Director, secret: string, wanted: boolean) => {
    if (!wanted) return { sent: false };
    try {
      await notifier.sendLink(d, linkOf(secret));
      log(`link emailed to director #${d.id}`);
      return { sent: true };
    } catch (e) {
      return { sent: false, error: (e as Error).message };
    }
  };

  r.get("/api/directors", async (c) => {
    app.requireOwner(c);
    json(c.res, 200, { directors: (await repo.listDirectors()).map(directorJson) });
  });

  r.post("/api/directors", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = await readJson(c.req);
    const { director, secret } = await repo.createDirector({
      name: str(b.name, "El nombre", 200, { required: true }),
      role: str(b.role, "El rol", 100),
      email: emailField(b.email),
      notify_versions: b.notify_versions === true,
      notify_replies: b.notify_replies === undefined ? "never" : replyNotify(b.notify_replies),
    });
    log(`director #${director.id} created`);
    const mail = await maybeSendLink(director, secret, b.send_link === true);
    json(c.res, 201, { director: directorJson(director), link: linkOf(secret), email: mail });
  });

  r.patch("/api/directors/:id", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const id = toInt(c.params[0]);
    const b = await readJson(c.req);
    const patch: Parameters<Repo["updateDirector"]>[1] = {};
    if ("name" in b) patch.name = str(b.name, "El nombre", 200, { required: true });
    if ("role" in b) patch.role = str(b.role, "El rol", 100);
    if ("email" in b) patch.email = emailField(b.email);
    if ("notify_versions" in b) patch.notify_versions = b.notify_versions === true;
    if ("notify_replies" in b) patch.notify_replies = replyNotify(b.notify_replies);
    const d = await repo.updateDirector(id, patch);
    if (!d) throw new HttpError(404, "No existe ese director.");
    json(c.res, 200, { director: directorJson(d) });
  });

  r.post("/api/directors/:id/rotate", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const id = toInt(c.params[0]);
    const b = c.req.headers["content-type"]?.startsWith("application/json") ? await readJson(c.req) : {};
    const res = await repo.rotateDirector(id);
    if (!res) throw new HttpError(404, "No existe ese director.");
    log(`director #${res.director.id} link rotated`);
    const mail = await maybeSendLink(res.director, res.secret, b.send_link === true);
    json(c.res, 200, { director: directorJson(res.director), link: linkOf(res.secret), email: mail });
  });

  r.post("/api/directors/:id/revoke", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const d = await repo.revokeDirector(toInt(c.params[0]));
    if (!d) throw new HttpError(404, "No existe ese director.");
    log(`director #${d.id} revoked`);
    json(c.res, 200, { director: directorJson(d) });
  });
}
