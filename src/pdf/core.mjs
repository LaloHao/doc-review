// PDF text extraction with pdf.js (pure JS, no canvas, no fonts; pdf.js 6 no
// longer uses eval). Plain JavaScript so that the worker thread (worker.mjs) can
// load it both from the TypeScript sources (tests) and from dist/.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

/** A PDF that can't be accepted: `code` (open, pages, read) and a detail for the owner. */
export class PdfProblem extends Error {
  /**
   * @param {"open" | "pages" | "read"} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Joins pdf.js text items; undoes end-of-line hyphenation ("pala-\nbra" → "palabra").
 * @param {{ str?: string; hasEOL?: boolean }[]} items
 * @returns {string}
 */
export function joinTextItems(items) {
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

/**
 * Opens the PDF and returns the text of every page. pdf.js may detach `data`.
 * @param {Uint8Array} data
 * @param {number} maxPages
 * @returns {Promise<{ pageCount: number; pages: string[] }>}
 */
export async function extractPages(data, maxPages) {
  const task = getDocument({ data, disableFontFace: true, useSystemFonts: false, stopAtErrors: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    throw new PdfProblem("open", /** @type {Error} */ (e).message);
  }
  try {
    if (doc.numPages < 1 || doc.numPages > maxPages) {
      throw new PdfProblem("pages", String(maxPages));
    }
    /** @type {string[]} */
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(joinTextItems(/** @type {{ str?: string; hasEOL?: boolean }[]} */ (tc.items)));
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages };
  } catch (e) {
    if (e instanceof PdfProblem) throw e;
    throw new PdfProblem("read", /** @type {Error} */ (e).message);
  } finally {
    await task.destroy();
  }
}
