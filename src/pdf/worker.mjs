// Worker thread that parses one uploaded PDF (see extract.ts): a hostile PDF
// can then only exhaust this thread's heap or time, never the server's.

import { parentPort } from "node:worker_threads";
import { extractPages, PdfProblem } from "./core.mjs";

parentPort?.once("message", async (/** @type {{ data: Uint8Array; maxPages: number }} */ msg) => {
  try {
    const r = await extractPages(msg.data, msg.maxPages);
    parentPort?.postMessage({ ok: true, ...r });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    parentPort?.postMessage(
      e instanceof PdfProblem
        ? { ok: false, problem: e.code, detail: e.detail, message: err.message }
        : { ok: false, problem: null, detail: "", message: err.message },
    );
  }
});
