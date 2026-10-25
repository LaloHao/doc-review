// Versions: publishing (owner), the viewer and changes pages, the PDF, the diff.

import { locateSections } from "../../diff.js";
import { validateProgress, ValidationError, type Progress } from "../../progress.js";
import { extractPdf, PdfError } from "../../pdf/extract.js";
import type { Version } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { sha256Hex } from "../crypto.js";
import { html, HttpError, json, readMultipart, redirect, send } from "../http.js";
import * as pages from "../pages.js";
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

  const getVersionOr404 = async (n: number): Promise<Version> => {
    const v = await repo.getVersion(n);
    if (!v) throw new HttpError(404, "No existe esa versión.");
    return v;
  };

  r.get("/v/latest", async (c) => {
    app.requireAny(c);
    const v = await repo.latestVersion();
    if (!v) throw new HttpError(404, "Aún no hay versiones.");
    redirect(c.res, `/v/${v.number}`);
  });

  r.get("/v/:n", async (c) => {
    app.requireAny(c);
    const v = await getVersionOr404(toInt(c.params[0], "La versión"));
    html(c.res, 200, pages.viewerPage(app.layout(c, `Tesis · versión ${v.number}`), v, await repo.listVersions()));
  });

  r.get("/v/:n/cambios", async (c) => {
    app.requireAny(c);
    const v = await getVersionOr404(toInt(c.params[0], "La versión"));
    const all = await repo.listVersions();
    const prev = all.find((x) => x.number < v.number) ?? null;
    html(c.res, 200, pages.changesPage(app.layout(c, `Versión ${v.number}: cambios`), v, prev, await app.diffFor(v)));
  });

  r.get("/api/versions", async (c) => {
    app.requireAny(c);
    json(c.res, 200, { versions: (await repo.listVersions()).map(versionJson) });
  });

  r.post("/api/versions", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const form = await readMultipart(c.req, config.maxPdfBytes + 2 * 1024 * 1024);
    const pdf = form.get("pdf");
    // progress.json is optional; "avance" is the thesis template's field name.
    const progressRaw = form.get("progress") ?? form.get("avance");
    const progressFile = progressRaw instanceof Blob && progressRaw.size > 0 ? progressRaw : null;
    if (!(pdf instanceof Blob)) throw new HttpError(400, "Falta el PDF (campo pdf).");
    if (pdf.size > config.maxPdfBytes) throw new HttpError(413, `El PDF supera ${Math.round(config.maxPdfBytes / 1048576)} MB.`);
    if (progressFile && progressFile.size > 1024 * 1024) throw new HttpError(413, "progress.json supera 1 MB.");
    const noteRaw = form.get("note");
    const note = str(typeof noteRaw === "string" ? noteRaw : "", "La nota", 5000);
    let progress: Progress | null = null;
    if (progressFile) {
      try {
        progress = validateProgress(JSON.parse(await progressFile.text()));
      } catch (e) {
        if (e instanceof ValidationError) throw new HttpError(400, e.message);
        throw new HttpError(400, "progress.json no es JSON válido.");
      }
    }
    const data = new Uint8Array(await pdf.arrayBuffer());
    let extracted;
    try {
      extracted = await extractPdf(data);
    } catch (e) {
      if (e instanceof PdfError) throw new HttpError(400, e.message);
      throw e;
    }
    const sha = sha256Hex(data);
    const sectionPages = locateSections(extracted.pages, progress);
    const key = `pdf/${sha}.pdf`;
    await store.put(key, data, "application/pdf");
    const v = await repo.createVersion({
      title: progress?.title ?? "",
      note,
      pdfKey: () => key,
      pdfSha256: sha,
      pdfSize: data.length,
      pages: extracted.pages,
      progress,
      sectionPages,
    });
    log(`version ${v.number} published (${extracted.pageCount} pages, ${data.length} bytes)`);
    app.later(async () => {
      await app.diffFor(v);
    });
    app.later(async () => notifier.versionPublished(v, await repo.listDirectors()));
    json(c.res, 201, { version: versionJson(v), url: `${config.publicUrl}/v/${v.number}` });
  });

  r.get("/api/versions/latest", async (c) => {
    app.requireAny(c);
    const v = await repo.latestVersion();
    if (!v) throw new HttpError(404, "Aún no hay versiones.");
    json(c.res, 200, { version: versionJson(v) });
  });

  r.get("/api/versions/:n", async (c) => {
    app.requireAny(c);
    json(c.res, 200, { version: versionJson(await getVersionOr404(toInt(c.params[0], "La versión"))) });
  });

  r.get("/api/versions/:n/diff", async (c) => {
    app.requireAny(c);
    json(c.res, 200, { diff: await app.diffFor(await getVersionOr404(toInt(c.params[0], "La versión"))) });
  });

  r.get("/api/versions/:n/pdf", async (c) => {
    app.requireAny(c);
    const v = await getVersionOr404(toInt(c.params[0], "La versión"));
    const data = await store.get(v.pdf_key);
    if (!data) throw new HttpError(404, "El PDF de esta versión no está en el almacenamiento.");
    send(c.res, 200, data, "application/pdf", {
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="tesis-v${v.number}.pdf"`,
      etag: `"${v.pdf_sha256}"`,
    });
  });
}
