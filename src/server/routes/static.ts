// Health checks, static files and the vendored pdf.js build. No authentication.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { App, Ctx } from "../context.js";
import { HttpError, redirect, send } from "../http.js";
import type { Router } from "../router.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "../../../public");
const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".icc": "application/octet-stream",
};

const VENDOR: Record<string, string> = {
  // The legacy build carries polyfills: reviewers may have older browsers.
  "pdf.mjs": "legacy/build/pdf.min.mjs",
  "pdf.worker.mjs": "legacy/build/pdf.worker.min.mjs",
};

/** Paths that skip authentication (and, for files, get a public cache header). */
export const isStaticPath = (p: string) => p.startsWith("/static/") || p.startsWith("/vendor/");
export const isHealthPath = (p: string) => p === "/healthz" || p === "/livez";

async function serveFile(c: Ctx, root: string, rel: string, maxAge: number): Promise<void> {
  const path = normalize(join(root, rel));
  if (!path.startsWith(root + sep)) throw new HttpError(404, "err.not_found");
  const type = MIME[extname(path)];
  if (!type) throw new HttpError(404, "err.not_found");
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    throw new HttpError(404, "err.not_found");
  }
  send(c.res, 200, data, type, { "cache-control": `public, max-age=${maxAge}` });
}

export function staticRoutes(r: Router<Ctx>, app: App): void {
  // Liveness: the process answers (no database, so a database outage doesn't
  // restart the pod in a loop). Readiness (/healthz) also checks the database.
  r.get("/livez", async (c) => send(c.res, 200, "ok", "text/plain; charset=utf-8"));
  r.get("/healthz", async (c) => {
    await app.repo.db.query("select 1");
    send(c.res, 200, "ok", "text/plain; charset=utf-8");
  });
  r.get("/static/(.+)", async (c) => serveFile(c, PUBLIC_DIR, c.params[0]!, 300));
  r.get("/vendor/pdfjs/(.+)", async (c) => {
    const rel = c.params[0]!;
    const mapped = VENDOR[rel] ?? (/^(cmaps|standard_fonts|wasm|iccs)\/[\w.-]+$/.test(rel) ? rel : null);
    if (!mapped) throw new HttpError(404, "err.not_found");
    await serveFile(c, PDFJS_DIR, mapped, 86400);
  });
  r.get("/favicon.ico", async (c) => redirect(c.res, "/static/favicon.svg"));
}
