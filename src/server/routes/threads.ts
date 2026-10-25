// Comment threads: list, open, reply, resolve/reopen, edit and delete comments.
// Notifications go out after the response.

import { participates } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { HttpError, json, readJson } from "../http.js";
import type { Router } from "../router.js";
import { intField, parseRects, str, toInt } from "../validate.js";

export function threadRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, notifier, log } = app;
  const threadUrl = (t: { version: number; id: number }) => `${config.publicUrl}/v/${t.version}#hilo-${t.id}`;

  /** A thread, if the viewer may see it (the visibility setting applies to directors). */
  const visibleThread = async (c: Ctx, id: number) => {
    const [t] = await repo.listThreads(app.viewerOf(c), { threadId: id });
    if (!t) throw new HttpError(404, "No existe ese hilo.");
    return t;
  };

  const notifyComment = (threadId: number, commentId: number) =>
    app.later(async () => {
      const [t] = await repo.listThreads({ kind: "owner", directorId: null }, { threadId });
      if (!t) return;
      await notifier.commentCreated(t, commentId);
      if (t.comments[0]?.id === commentId || !notifier.enabled.directorEmail) return; // a new thread, not a reply
      // Directors who chose instant reply emails and take part in the thread,
      // as each of them sees it: a comment they can't see never notifies them.
      for (const d of await repo.listDirectors()) {
        if (d.notify_replies !== "instant" || !d.email || d.revoked_at) continue;
        const [mine] = await repo.listThreads({ kind: "director", directorId: d.id }, { threadId });
        const cm = mine?.comments.find((x) => x.id === commentId);
        if (!mine || !cm || (cm.author.kind === "director" && cm.author.director_id === d.id) || !participates(mine, d.id)) continue;
        try {
          await notifier.replyToDirector(d, mine, cm);
          log(`reply notification emailed to director #${d.id}`);
        } catch (e) {
          log(`reply email failed for director #${d.id}: ${(e as Error).message}`);
        }
      }
    });

  r.get("/api/threads", async (c) => {
    const viewer = app.requireAny(c);
    const version = c.url.searchParams.get("version");
    const status = c.url.searchParams.get("status");
    let versionNumber: number | undefined;
    if (version === "latest") versionNumber = (await repo.latestVersion())?.number ?? -1;
    else if (version) versionNumber = toInt(version, "La versión");
    if (status && status !== "open" && status !== "resolved" && status !== "all") throw new HttpError(400, "status: open, resolved o all.");
    const threads = await repo.listThreads(viewer, {
      versionNumber,
      status: status === "open" || status === "resolved" ? status : undefined,
    });
    json(c.res, 200, { threads: threads.map((t) => ({ ...t, url: threadUrl(t) })) });
  });

  r.get("/api/threads/:id", async (c) => {
    const t = await visibleThread(c, toInt(c.params[0]));
    json(c.res, 200, { thread: { ...t, url: threadUrl(t) } });
  });

  r.post("/api/threads", async (c) => {
    const viewer = app.requireAny(c);
    app.checkCsrf(c);
    await app.writeAllowed(viewer);
    const b = await readJson(c.req);
    const v = await repo.getVersion(intField(b.version, "version"));
    if (!v) throw new HttpError(404, "No existe esa versión.");
    if (typeof b.page !== "number" || !Number.isInteger(b.page) || b.page < 1 || b.page > v.page_count) {
      throw new HttpError(400, "Página fuera del documento.");
    }
    const page = b.page;
    const anchor = b.anchor === "point" ? "point" : b.anchor === "text" ? "text" : null;
    if (!anchor) throw new HttpError(400, "anchor debe ser text o point.");
    const quote = str(b.quote, "La cita", 2000, { required: anchor === "text" });
    const rects = parseRects(b.rects);
    const body = str(b.body, "El comentario", 10_000, { required: true });
    const id = await repo.createThread(v, { page, anchor, quote: anchor === "text" ? quote : "", rects, body }, viewer);
    const t = await visibleThread(c, id);
    notifyComment(id, t.comments[0]!.id);
    json(c.res, 201, { thread: { ...t, url: threadUrl(t) } });
  });

  r.post("/api/threads/:id/comments", async (c) => {
    const viewer = app.requireAny(c);
    app.checkCsrf(c);
    await app.writeAllowed(viewer);
    const t = await visibleThread(c, toInt(c.params[0]));
    const b = await readJson(c.req);
    const body = str(b.body, "La respuesta", 10_000, { required: true });
    const commentId = await repo.addReply(t.id, body, viewer);
    notifyComment(t.id, commentId);
    json(c.res, 201, { thread: await visibleThread(c, t.id), comment_id: commentId });
  });

  // Resolving: the owner, or the director who opened the thread. Reopening:
  // anyone who can see it.
  const setStatus = (status: "open" | "resolved") => async (c: Ctx) => {
    const viewer = app.requireAny(c);
    app.checkCsrf(c);
    const t = await visibleThread(c, toInt(c.params[0]));
    if (status === "resolved" && !t.can_resolve) {
      throw new HttpError(403, "Solo quien abrió el hilo o el autor de la tesis pueden marcarlo como resuelto.");
    }
    await repo.setStatus(t.id, status, { ...viewer, name: app.whoName(c.session!) });
    json(c.res, 200, { thread: await visibleThread(c, t.id) });
  };
  r.post("/api/threads/:id/resolve", setStatus("resolved"));
  r.post("/api/threads/:id/reopen", setStatus("open"));

  const ownComment = async (c: Ctx) => {
    const viewer = app.requireAny(c);
    app.checkCsrf(c);
    const id = toInt(c.params[0]);
    const comment = await repo.getComment(id);
    if (!comment || comment.deleted_at) throw new HttpError(404, "No existe ese comentario.");
    await visibleThread(c, comment.thread_id);
    const mine = comment.author_kind === viewer.kind && (viewer.kind === "owner" || comment.director_id === viewer.directorId);
    if (!mine) throw new HttpError(403, "Solo puede modificar sus propios comentarios.");
    return comment;
  };

  r.patch("/api/comments/:id", async (c) => {
    const comment = await ownComment(c);
    const b = await readJson(c.req);
    const body = str(b.body, "El comentario", 10_000, { required: true });
    const previous = await repo.editComment(comment.id, body);
    if (comment.author_kind === "director" && previous !== null && previous !== body) {
      app.later(async () => {
        const [t] = await repo.listThreads({ kind: "owner", directorId: null }, { threadId: comment.thread_id });
        if (t) await notifier.commentEdited(t, comment.id, previous);
      });
    }
    json(c.res, 200, { thread: await visibleThread(c, comment.thread_id) });
  });

  // Previous texts of an edited comment (owner only).
  r.get("/api/comments/:id/edits", async (c) => {
    app.requireOwner(c);
    const id = toInt(c.params[0]);
    if (!(await repo.getComment(id))) throw new HttpError(404, "No existe ese comentario.");
    const edits = await repo.commentEdits(id);
    json(c.res, 200, { edits: edits.map((e) => ({ body: e.body, edited_at: new Date(e.edited_at).toISOString() })) });
  });

  r.delete("/api/comments/:id", async (c) => {
    const comment = await ownComment(c);
    await repo.deleteComment(comment.id);
    json(c.res, 200, { thread: await visibleThread(c, comment.thread_id) });
  });
}
