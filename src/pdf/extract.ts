// Server-side PDF validation and text extraction. An upload is accepted only if
// pdf.js can open every page. Parsing runs in a worker thread with its own heap
// limit and a timeout (worker.mjs, core.mjs), so a hostile or huge PDF can't take
// the server down or block it.

import { Worker } from "node:worker_threads";
import { joinTextItems } from "./core.mjs";

export { joinTextItems };

export class PdfError extends Error {}

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
  | { ok: false; problem: boolean; message: string };

export async function extractPdf(data: Uint8Array, opts: ExtractOptions = {}): Promise<ExtractedPdf> {
  if (!looksLikePdf(data)) throw new PdfError("El archivo no es un PDF.");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const worker = new Worker(WORKER_URL, {
    resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? 512, maxYoungGenerationSizeMb: 32 },
    stdout: false,
    stderr: false,
  });
  try {
    const reply = await new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PdfError(`El PDF tardó demasiado en procesarse (más de ${Math.round(timeoutMs / 1000)} s).`)), timeoutMs);
      worker.once("message", (m: WorkerReply) => {
        clearTimeout(timer);
        resolve(m);
      });
      worker.once("error", (e: Error & { code?: string }) => {
        clearTimeout(timer);
        reject(
          e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new PdfError("El PDF necesita demasiada memoria para procesarse.")
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
    if (!reply.ok) throw reply.problem ? new PdfError(reply.message) : new Error(`PDF worker: ${reply.message}`);
    return { pageCount: reply.pageCount, pages: reply.pages };
  } finally {
    await worker.terminate();
  }
}
