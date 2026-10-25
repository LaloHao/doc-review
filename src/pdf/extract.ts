// Server-side PDF validation and text extraction. An upload is accepted only if
// pdf.js can open every page. Parsing runs in a worker thread with its own heap
// limit and a timeout (worker.mjs, core.mjs), so a hostile or huge PDF can't take
// the server down or block it.

import { Worker } from "node:worker_threads";
import type { MsgKey } from "../i18n/index.js";
import { joinTextItems } from "./core.mjs";

export { joinTextItems };

/** A PDF that can't be accepted: a message key and its parameters, for the owner. */
export class PdfError extends Error {
  constructor(
    readonly key: MsgKey,
    readonly params: Record<string, string | number> = {},
  ) {
    super(`${key} ${JSON.stringify(params)}`);
  }
}

const PROBLEM_KEYS: Record<string, MsgKey> = { open: "err.pdf_open", pages: "err.pdf_pages", read: "err.pdf_read" };

export const MAX_PAGES = 2000;

export interface ExtractedPdf {
  pageCount: number;
  /** Text of each page (index 0 = page 1), lines joined, hyphenation undone. */
  pages: string[];
}

export interface ExtractOptions {
  /** Give up after this long (default 90 s). */
  timeoutMs?: number;
  /** Old-generation heap of the worker (default 512 MB). */
  maxHeapMb?: number;
}

export function looksLikePdf(data: Uint8Array): boolean {
  // "%PDF-" at the start (the spec allows leading garbage; we don't).
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, 1024)).toString("latin1");
  return head.startsWith("%PDF-");
}

const WORKER_URL = new URL("./worker.mjs", import.meta.url);

type WorkerReply =
  | { ok: true; pageCount: number; pages: string[] }
  | { ok: false; problem: "open" | "pages" | "read" | null; detail: string; message: string };

export async function extractPdf(data: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractedPdf> {
  if (!looksLikePdf(data)) throw new PdfError("err.pdf_not_pdf");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const worker = new Worker(WORKER_URL, {
    resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? 512, maxYoungGenerationSizeMb: 32 },
    stdout: false,
    stderr: false,
  });
  try {
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PdfError("err.pdf_timeout", { s: Math.max(1, Math.round(timeoutMs / 1000)) })), timeoutMs);
      worker.once("message", (m: WorkerReply) => {
        clearTimeout(timer);
        resolve(m);
      });
      worker.once("error", (e: Error & { code?: string }) => {
        clearTimeout(timer);
        reject(
          e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new PdfError("err.pdf_memory")
            : new Error(`PDF worker failed: ${e.message}`),
        );
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`PDF worker exited (${code})`));
      });
      // Structured clone: the worker gets its own copy (pdf.js detaches it).
      worker.postMessage({ data, maxPages: MAX_PAGES });
    });
    if (!reply.ok) {
      throw reply.problem
        ? new PdfError(PROBLEM_KEYS[reply.problem]!, reply.problem === "pages" ? { max: Number(reply.detail) } : { detail: reply.detail.slice(0, 300) })
        : new Error(`PDF worker: ${reply.message}`);
    }
    return { pageCount: reply.pageCount, pages: reply.pages };
  } finally {
    await worker.terminate();
  }
}
