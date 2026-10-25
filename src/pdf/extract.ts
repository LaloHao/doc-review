// Server-side PDF validation and text extraction with pdf.js (pure JS, no canvas,
// no fonts; pdf.js 6 no longer uses eval). An upload is accepted only if pdf.js can open every page.

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

export class PdfError extends Error {}

export const MAX_PAGES = 2000;

export interface ExtractedPdf {
  pageCount: number;
  /** Text of each page (index 0 = page 1), lines joined, hyphenation undone. */
  pages: string[];
}

export function looksLikePdf(data: Uint8Array): boolean {
  // "%PDF-" within the first 1024 bytes (the spec allows leading garbage; we don't
  // allow much of it).
  const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");
  return head.startsWith("%PDF-");
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** Joins pdf.js text items; undoes end-of-line hyphenation ("pala-\nbra" → "palabra"). */
export function joinTextItems(items: TextItemLike[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    out += it.str;
    if (it.hasEOL) out += "\n";
  }
  return out
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export async function extractPdf(data: Uint8Array): Promise<ExtractedPdf> {
  if (!looksLikePdf(data)) throw new PdfError("El archivo no es un PDF.");
  let doc;
  const task = getDocument({
    // pdf.js may transfer (detach) the buffer it is given: pass a copy.
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    throw new PdfError(`pdf.js no pudo abrir el PDF: ${(e as Error).message}`);
  }
  try {
    if (doc.numPages < 1 || doc.numPages > MAX_PAGES) {
      throw new PdfError(`El PDF debe tener entre 1 y ${MAX_PAGES} páginas.`);
    }
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(joinTextItems(tc.items as TextItemLike[]));
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages };
  } catch (e) {
    if (e instanceof PdfError) throw e;
    throw new PdfError(`pdf.js no pudo leer el PDF: ${(e as Error).message}`);
  } finally {
    await task.destroy();
  }
}
