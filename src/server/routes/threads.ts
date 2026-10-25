// Comment threads: list, open, reply, resolve/reopen, edit and delete comments.
// Notifications go out after the response.

import { OWNER, participates, type Document, type ThreadOut } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { HttpError, json, readJson } from "../http.js";
import type { Router } from "../router.js";
import { intField, parseRects, str, toInt } from "../validate.js";

export function threadRoutes(r: Router<Ctx>, app: App): void {
  const { repo, notifier, log } = app;
  const out = (t: ThreadOut) => ({ ...t, url: app.threadUrl(t) });

  const notifyComment = (doc: Document, threadId: number, commentId: number) =>
    app.later(async () => {
      const [t] = await repo.listThreads(doc, OWNER, { threadId });
      if (!t) return;
      await notifier.commentCreated(doc, t, commentId);
      if (t.comments[0]?.id === commentId || !notifier.enabled.reviewerEmail) return; // a new thread, not a reply
      // Reviewers who chose instant reply emails and take part in the thread, as
      // each of them sees it: a comment they can't see never notifies them.
      for (const inv of await repo.invitationsOfDocument(doc.id)) {
        const p = inv.person;
        if (inv.revoked_at || p.notify_replies !== "instant" || !p.email) continue;
        const [mine] = await repo.listThreads(doc, { kind: "reviewer", personId: p.id }, { threadId });
        const cm = mine?.comments.find((x) => x.id === commentId);
        if (!mine || !cm || (cm.author.kind === "reviewer" && cm.author.person_id === p.id) || !participates(mine, p.id)) continue;
        try {
          await notifier.replyToReviewer(doc, p, mine, cm);
          log(`reply notification emailed to person #${p.id}`);
        } catch (e) {
          log(`reply email failed for person #${p.id}: ${(e as Error).message}`);
        }
      }
    });

  r.get("/api/documents/:slug/threads", async (c) => {
    const viewer = app.viewerOf(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    const version = c.url.searchParams.get("version");
    const status = c.url.searchParams.get("status");
    let versionNumber: number | undefined;
    if (version === "latest") versionNumber = (await repo.latestVersion(doc.id))?.number ?? -1;
    else if (version) versionNumber = toInt(version, "field.version");
    if (status && status !== "open" && status !== "resolved" && status !== "all") throw new HttpError(400, "err.status_filter");
    const threads = await repo.listThreads(doc, viewer, {
      versionNumber,
      status: status === "open" || status === "resolved" ? status : undefined,
    });
    json(c.res, 200, { threads: threads.map(out) });
  });

  r.post("/api/documents/:slug/threads", async (c) => {
    const viewer = app.viewerOf(c);
    app.checkCsrf(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    app.requireWritable(doc);
    await app.writeAllowed(viewer);
    const b = await readJson(c.req);
    const v = await repo.getVersion(doc.id, intField(b.version, "field.version"));
    if (!v) throw new HttpError(404, "err.no_version");
    if (typeof b.page !== "number" || !Number.isInteger(b.page) || b.page < 1 || b.page > v.page_count) {
      throw new HttpError(400, "err.page_range");
    }
    const page = b.page;
    const anchor = b.anchor === "point" ? "point" : b.anchor === "text" ? "text" : null;
    if (!anchor) throw new HttpError(400, "err.anchor");
    const quote = str(b.quote, "field.quote", 2000, { required: anchor === "text" });
    const rects = parseRects(b.rects);
    const body = str(b.body, "field.comment", 10_000, { required: true });
    const id = await repo.createThread(v, { page, anchor, quote: anchor === "text" ? quote : "", rects, body }, viewer);
    const { thread } = await app.threadFor(c, id);
    notifyComment(doc, id, thread.comments[0]!.id);
    json(c.res, 201, { thread: out(thread) });
  });

  r.get("/api/threads/:id", async (c) => {
    const { thread } = await app.threadFor(c, toInt(c.params[0]));
    json(c.res, 200, { thread: out(thread) });
  });

  r.post("/api/threads/:id/comments", async (c) => {
    const viewer = app.viewerOf(c);
    app.checkCsrf(c);
    const { doc, thread } = await app.threadFor(c, toInt(c.params[0]));
    app.requireWritable(doc);
    await app.writeAllowed(viewer);
    const b = await readJson(c.req);
    const body = str(b.body, "field.reply", 10_000, { required: true });
    const commentId = await repo.addReply(thread.id, body, viewer);
    notifyComment(doc, thread.id, commentId);
    json(c.res, 201, { thread: out((await app.threadFor(c, thread.id)).thread), comment_id: commentId });
  });

  // Resolving: the owner, or the reviewer who opened the thread. Reopening:
  // anyone who can see it.
  const setStatus = (status: "open" | "resolved") => async (c: Ctx) => {
    const viewer = app.viewerOf(c);
    app.checkCsrf(c);
    const { doc, thread } = await app.threadFor(c, toInt(c.params[0]));
    app.requireWritable(doc);
    if (status === "resolved" && !thread.can_resolve) throw new HttpError(403, "err.resolve_forbidden");
    await repo.setStatus(thread.id, status, viewer);
    json(c.res, 200, { thread: out((await app.threadFor(c, thread.id)).thread) });
  };
  r.post("/api/threads/:id/resolve", setStatus("resolved"));
  r.post("/api/threads/:id/reopen", setStatus("open"));

  const ownComment = async (c: Ctx) => {
    const viewer = app.viewerOf(c);
    app.checkCsrf(c);
    const comment = await repo.getComment(toInt(c.params[0]));
    if (!comment || comment.deleted_at) throw new HttpError(404, "err.no_comment");
    const { doc } = await app.threadFor(c, comment.thread_id);
    app.requireWritable(doc);
    const mine = comment.author_kind === viewer.kind && (viewer.kind === "owner" || comment.person_id === viewer.personId);
    if (!mine) throw new HttpError(403, "err.own_comments_only");
    return { comment, doc };
  };

  r.patch("/api/comments/:id", async (c) => {
    const { comment, doc } = await ownComment(c);
    const b = await readJson(c.req);
    const body = str(b.body, "field.comment", 10_000, { required: true });
    const previous = await repo.editComment(comment.id, body);
    if (comment.author_kind === "reviewer" && previous !== null && previous !== body) {
      app.later(async () => {
        const [t] = await repo.listThreads(doc, OWNER, { threadId: comment.thread_id });
        if (t) await notifier.commentEdited(doc, t, comment.id, previous);
      });
    }
    json(c.res, 200, { thread: out((await app.threadFor(c, comment.thread_id)).thread) });
  });

  // Previous texts of an edited comment (owner only).
  r.get("/api/comments/:id/edits", async (c) => {
    app.requireOwner(c);
    const id = toInt(c.params[0]);
    if (!(await repo.getComment(id))) throw new HttpError(404, "err.no_comment");
    const edits = await repo.commentEdits(id);
    json(c.res, 200, { edits: edits.map((e) => ({ body: e.body, edited_at: new Date(e.edited_at).toISOString() })) });
  });

  r.delete("/api/comments/:id", async (c) => {
    const { comment } = await ownComment(c);
    await repo.deleteComment(comment.id);
    json(c.res, 200, { thread: out((await app.threadFor(c, comment.thread_id)).thread) });
  });
}
