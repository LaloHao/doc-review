// Versions of a document: publishing (owner), the viewer and changes pages,
// the PDF and the diff.

import { locateSections } from "../../diff.js";
import { extractPdf, PdfError } from "../../pdf/extract.js";
import { validateProgress, ValidationError, type Progress } from "../../progress.js";
import type { Document, Version } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { docTr } from "../context.js";
import { sha256Hex } from "../crypto.js";
import { html, HttpError, json, readMultipart, redirect, send } from "../http.js";
import { changesPage, viewerPage } from "../pages/viewer.js";
import type { Router } from "../router.js";
import { str, toInt } from "../validate.js";

export const versionJson = (v: Version) => ({
  number: v.number,
  title: v.title,
  note: v.note,
  page_count: v.page_count,
  pdf_size: v.pdf_size,
  pdf_sha256: v.pdf_sha256,
  created_at: new Date(v.created_at).toISOString(),
  progress: v.progress,
  sections: v.section_pages,
});

export function versionRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, store, notifier, log } = app;

  const versionOr404 = async (doc: Document, n: string | undefined): Promise<Version> => {
    const v = n === "latest" ? await repo.latestVersion(doc.id) : await repo.getVersion(doc.id, toInt(n, "field.version"));
    if (!v) throw new HttpError(404, "err.no_version");
    return v;
  };

  r.get("/d/:slug/v/:n", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    const v = await versionOr404(doc, c.params[1]);
    if (c.params[1] === "latest") return redirect(c.res, `/d/${doc.slug}/v/${v.number}`);
    const tr = docTr(doc);
    html(c.res, 200, viewerPage(app.layout(c, tr, tr("viewer.title", { title: doc.title, n: v.number }), { doc }), doc, v, await repo.listVersions(doc.id)));
  });

  r.get("/d/:slug/v/:n/changes", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    const v = await versionOr404(doc, c.params[1]);
    const tr = docTr(doc);
    html(c.res, 200, changesPage(app.layout(c, tr, tr("changes.title", { n: v.number }), { doc }), doc, v, await repo.previousVersion(v), await app.diffFor(v)));
  });

  r.get("/api/documents/:slug/versions", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    json(c.res, 200, { versions: (await repo.listVersions(doc.id)).map(versionJson) });
  });

  r.post("/api/documents/:slug/versions", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    app.requireWritable(doc);
    const form = await readMultipart(c.req, config.maxPdfBytes + 2 * 1024 * 1024);
    const pdf = form.get("pdf");
    // progress.json is optional; "avance" is the thesis template's field name.
    const progressRaw = form.get("progress") ?? form.get("avance");
    const progressFile = progressRaw instanceof Blob && progressRaw.size > 0 ? progressRaw : null;
    if (!(pdf instanceof Blob)) throw new HttpError(400, "err.pdf_missing");
    const mb = Math.round(config.maxPdfBytes / 1048576);
    if (pdf.size > config.maxPdfBytes) throw new HttpError(413, "err.pdf_too_large", { mb });
    if (progressFile && progressFile.size > 1024 * 1024) throw new HttpError(413, "err.progress_too_large");
    const noteRaw = form.get("note");
    const note = str(typeof noteRaw === "string" ? noteRaw : "", "field.note", 5000);
    let progress: Progress | null = null;
    if (progressFile) {
      try {
        progress = validateProgress(JSON.parse(await progressFile.text()));
      } catch (e) {
        if (e instanceof ValidationError) throw new HttpError(400, "err.progress_invalid", { detail: e.message });
        throw new HttpError(400, "err.progress_not_json");
      }
    }
    const data = new Uint8Array(await pdf.arrayBuffer());
    let extracted;
    try {
      extracted = await extractPdf(data);
    } catch (e) {
      if (e instanceof PdfError) throw new HttpError(400, e.key, e.params);
      throw e;
    }
    const sha = sha256Hex(data);
    const key = `pdf/${sha}.pdf`;
    await store.put(key, data, "application/pdf");
    const v = await repo.createVersion(doc, {
      title: progress?.title ?? doc.title,
      note,
      pdfKey: key,
      pdfSha256: sha,
      pdfSize: data.length,
      pages: extracted.pages,
      progress,
      sectionPages: locateSections(extracted.pages, progress),
    });
    log(`document #${doc.id} version ${v.number} published (${extracted.pageCount} pages, ${data.length} bytes)`);
    app.later(async () => {
      await app.diffFor(v);
    });
    app.later(async () => {
      const recipients = (await repo.invitationsOfDocument(doc.id)).filter((i) => !i.revoked_at).map((i) => i.person);
      await notifier.versionPublished(doc, v, recipients);
    });
    json(c.res, 201, { version: versionJson(v), url: `${config.publicUrl}/d/${doc.slug}/v/${v.number}` });
  });

  r.get("/api/documents/:slug/versions/:n", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    json(c.res, 200, { version: versionJson(await versionOr404(doc, c.params[1])) });
  });

  r.get("/api/documents/:slug/versions/:n/diff", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    json(c.res, 200, { diff: await app.diffFor(await versionOr404(doc, c.params[1])) });
  });

  r.get("/api/documents/:slug/versions/:n/pdf", async (c) => {
    const { doc } = await app.documentFor(c, c.params[0]);
    const v = await versionOr404(doc, c.params[1]);
    const data = await store.get(v.pdf_key);
    if (!data) throw new HttpError(404, "err.pdf_not_stored");
    send(c.res, 200, data, "application/pdf", {
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${doc.slug}-v${v.number}.pdf"`,
      etag: `"${v.pdf_sha256}"`,
    });
  });

}
