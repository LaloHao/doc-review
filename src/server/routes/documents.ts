// Documents: the home page (landing, owner dashboard, a reviewer's list), a
// document's entry and management pages, and the documents API.

import { translator } from "../../i18n/index.js";
import type { Document, DocumentSummary, Invitation } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { docTr } from "../context.js";
import { html, HttpError, json, readJson, redirect } from "../http.js";
import { documentManagePage, ownerDashboard } from "../pages/owner.js";
import { landingPage, noVersionsPage, reviewerHome } from "../pages/reviewer.js";
import type { Router } from "../router.js";
import { language, line, slug, visibility } from "../validate.js";

export function documentJson(app: App, d: Document, s?: DocumentSummary, invitation?: Invitation | null) {
  return {
    slug: d.slug,
    title: d.title,
    language: d.language,
    visibility: d.visibility,
    default_role: d.default_role,
    archived: d.archived_at !== null,
    created_at: new Date(d.created_at).toISOString(),
    url: `${app.config.publicUrl}/d/${d.slug}`,
    ...(s
      ? {
          latest_version: s.latest ? { number: s.latest.number, created_at: new Date(s.latest.created_at).toISOString(), total_words: s.latest.progress?.total_words ?? null } : null,
          versions: s.versions,
          open_threads: s.open_threads,
          ...(s.reviewers >= 0 ? { reviewers: s.reviewers } : {}),
        }
      : {}),
    ...(invitation ? { role: invitation.role } : {}),
  };
}

export function documentRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, notifier } = app;

  /**
   * Summaries as a reviewer sees them: open threads they can see (the
   * document's visibility applies), and no count of the other reviewers.
   */
  const reviewerSummaries = async (personId: number, docs: Document[]): Promise<DocumentSummary[]> => {
    const all = await repo.documentSummaries(docs);
    return Promise.all(
      all.map(async (s) => ({
        ...s,
        open_threads: (await repo.listThreads(s.document, { kind: "reviewer", personId }, { status: "open" })).length,
        reviewers: -1,
      })),
    );
  };

  r.get("/", async (c) => {
    const tr = translator(c.lang);
    if (!c.session) return html(c.res, 200, landingPage(tr));
    if (c.session.kind === "reviewer") {
      const invitations = await repo.invitationsOfPerson(c.session.person!.id, { activeOnly: true });
      const current = invitations.filter((i) => !i.document.archived_at);
      // One document: straight to it.
      if (current.length === 1 && invitations.length === 1) return redirect(c.res, `/d/${current[0]!.document.slug}`);
      const summaries = await reviewerSummaries(c.session.person!.id, invitations.map((i) => i.document));
      return html(
        c.res,
        200,
        reviewerHome(app.layout(c, tr, tr("home.title")), app.whoName(c.session), invitations.map((invitation, k) => ({ invitation, summary: summaries[k]! }))),
      );
    }
    html(
      c.res,
      200,
      ownerDashboard(app.layout(c, tr, tr("dash.title")), {
        summaries: await repo.documentSummaries(),
        people: await repo.listPeople(),
        archivedPeople: (await repo.listPeople({ archived: true })).filter((p) => p.archived_at),
        invitations: await repo.allInvitations(),
        channels: { ...notifier.enabled, digestHour: config.digestHour, timeZone: config.timeZone },
      }),
    );
  });

  r.get("/d/:slug", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    const latest = await repo.latestVersion(doc.id);
    if (latest) return redirect(c.res, `/d/${doc.slug}/v/${latest.number}`);
    if (c.session!.kind === "owner") return redirect(c.res, `/d/${doc.slug}/manage`);
    const tr = docTr(doc);
    html(c.res, 200, noVersionsPage(app.layout(c, tr, doc.title, { doc })));
  });

  r.get("/d/:slug/manage", async (c) => {
    app.requireOwner(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    const tr = translator(c.lang);
    const versions = await repo.listVersions(doc.id);
    const open = await repo.listThreads(doc, { kind: "owner", personId: null }, { status: "open" });
    const openByVersion = new Map<number, number>();
    for (const t of open) openByVersion.set(t.version, (openByVersion.get(t.version) ?? 0) + 1);
    html(
      c.res,
      200,
      documentManagePage(app.layout(c, tr, tr("manage.page_title", { title: doc.title }), { doc }), {
        doc,
        versions,
        openByVersion,
        invitations: await repo.invitationsOfDocument(doc.id),
        people: await repo.listPeople(),
        maxPdfMb: Math.round(config.maxPdfBytes / 1024 / 1024),
      }),
    );
  });

  // --- API ---

  r.get("/api/documents", async (c) => {
    const viewer = app.viewerOf(c);
    if (viewer.kind === "owner") {
      const summaries = await repo.documentSummaries();
      return json(c.res, 200, { documents: summaries.map((s) => documentJson(app, s.document, s)) });
    }
    const invitations = await repo.invitationsOfPerson(viewer.personId!, { activeOnly: true });
    const summaries = await reviewerSummaries(viewer.personId!, invitations.map((i) => i.document));
    json(c.res, 200, { documents: invitations.map((i, k) => documentJson(app, i.document, summaries[k], i)) });
  });

  r.post("/api/documents", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = await readJson(c.req);
    const d = await repo.createDocument({
      slug: slug(b.slug),
      title: line(b.title, "field.title", 300, { required: true }),
      language: b.language === undefined ? "en" : language(b.language),
      visibility: b.visibility === undefined ? "all" : visibility(b.visibility),
      default_role: line(b.default_role, "field.role", 100),
    });
    if (!d) throw new HttpError(409, "err.slug_taken");
    app.log(`document #${d.id} created`);
    json(c.res, 201, { document: documentJson(app, d) });
  });

  r.get("/api/documents/:slug", async (c) => {
    const { doc, invitation } = await app.documentFor(c, c.params[0]);
    const [s] = invitation ? await reviewerSummaries(invitation.person_id, [doc]) : await repo.documentSummaries([doc]);
    json(c.res, 200, { document: documentJson(app, doc, s, invitation) });
  });

  r.patch("/api/documents/:slug", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    const b = await readJson(c.req);
    const patch: Parameters<typeof repo.updateDocument>[1] = {};
    if ("slug" in b) patch.slug = slug(b.slug);
    if ("title" in b) patch.title = line(b.title, "field.title", 300, { required: true });
    if ("language" in b) patch.language = language(b.language);
    if ("visibility" in b) patch.visibility = visibility(b.visibility);
    if ("default_role" in b) patch.default_role = line(b.default_role, "field.role", 100);
    const d = await repo.updateDocument(doc.id, patch);
    if (d === "taken") throw new HttpError(409, "err.slug_taken");
    if (!d) throw new HttpError(404, "err.no_document");
    json(c.res, 200, { document: documentJson(app, d) });
  });

  const setArchived = (archived: boolean) => async (c: Ctx) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    const d = await repo.setArchived(doc.id, archived);
    app.log(`document #${doc.id} ${archived ? "archived" : "unarchived"}`);
    json(c.res, 200, { document: documentJson(app, d!) });
  };
  r.post("/api/documents/:slug/archive", setArchived(true));
  r.post("/api/documents/:slug/unarchive", setArchived(false));
}
