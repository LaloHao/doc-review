// HTTP application: routing, authentication, CSRF, security headers, handlers.
//
// Authentication, checked on every route except /healthz, /static, /vendor, the
// landing page, the owner login and the director link:
// - Owner via API: `Authorization: Bearer <owner token>` (Emacs, CLI). No cookies
//   are read when this header is present, so no CSRF applies.
// - Owner on the web: the token is entered once at /entrar → session cookie.
// - Director: the secret link /acceso/<secret> → session cookie → redirect to /.
// Cookie-authenticated mutations need Origin == PUBLIC_URL and the session's CSRF
// token in X-CSRF-Token (or the _csrf form field). Cookies are HttpOnly, Secure,
// SameSite=Lax.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAvance, ValidationError } from "../avance.js";
import type { Config } from "../config.js";
import { diffVersions, locateChapters, type VersionDiff } from "../diff.js";
import type { Notifier } from "../notify/notify.js";
import { extractPdf, PdfError } from "../pdf/extract.js";
import type { Rect, Repo, Session, Version, Viewer, Visibility } from "../repo.js";
import type { BlobStore } from "../storage.js";
import { newSecret, safeEqual, sha256Hex } from "./crypto.js";
import {
  cookie,
  html,
  HttpError,
  json,
  parseCookies,
  readForm,
  readJson,
  readMultipart,
  redirect,
  send,
} from "./http.js";
import * as pages from "./pages.js";
import { esc } from "../text.js";
import { RateLimiter } from "./ratelimit.js";

export const SESSION_COOKIE = "__Host-rt_session";
const PRE_COOKIE = "__Host-rt_pre";
const OWNER_TTL = 30 * 24 * 3600_000;
const DIRECTOR_TTL = 180 * 24 * 3600_000;

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "../../public");
const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));

export interface AppDeps {
  config: Config;
  repo: Repo;
  store: BlobStore;
  notifier: Notifier;
  log?: (msg: string) => void;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  params: string[];
  session: Session | null;
  bearer: boolean;
}

type Handler = (c: Ctx) => Promise<void>;

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}

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

export function securityHeaders(config: Config): Record<string, string> {
  const h: Record<string, string> = {
    "content-security-policy": [
      "default-src 'none'",
      // pdf.js may compile its WebAssembly decoders (JPEG 2000, ICC colors).
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  };
  if (config.publicUrl.startsWith("https://")) h["strict-transport-security"] = "max-age=31536000";
  return h;
}

function toInt(s: string | undefined | null): number | null {
  if (!s || !/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

function str(v: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, `Falta ${field}.`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} debe ser texto.`);
  const s = v.replace(/\u0000/g, "").trim();
  if (opts.required && s === "") throw new HttpError(400, `Falta ${field}.`);
  if (s.length > max) throw new HttpError(400, `${field} es demasiado largo (máx. ${max}).`);
  return s;
}

function parseRects(v: unknown): Rect[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 50) throw new HttpError(400, "rects debe tener de 1 a 50 rectángulos.");
  return v.map((r) => {
    if (typeof r !== "object" || r === null) throw new HttpError(400, "rect no válido.");
    const o = r as Record<string, unknown>;
    const n = (k: string) => {
      const x = o[k];
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) throw new HttpError(400, `rect.${k} debe estar entre 0 y 1.`);
      return Math.round(x * 1e5) / 1e5;
    };
    return { x: n("x"), y: n("y"), w: n("w"), h: n("h") };
  });
}

function isEmail(s: string): boolean {
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s) && s.length <= 320;
}

export function createApp(deps: AppDeps) {
  const { config, repo, store, notifier } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));
  const sec = securityHeaders(config);
  const linkLimiter = new RateLimiter(20, 10 * 60_000);
  const loginLimiter = new RateLimiter(10, 10 * 60_000);
  const bearerLimiter = new RateLimiter(30, 10 * 60_000); // failed bearer attempts
  const writeLimiter = new RateLimiter(60, 60_000);
  const diffCache = new Map<number, VersionDiff | null>();
  const routes: Route[] = [];

  const route = (method: string, pattern: string, handler: Handler) => {
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "([^/]+)") + "$");
    routes.push({ method, re, handler });
  };

  // --- auth helpers ---

  const ownerTokenOk = (token: string) =>
    config.ownerTokenSha256 !== "" && safeEqual(sha256Hex(token), config.ownerTokenSha256);

  const viewerOf = (c: Ctx): Viewer => {
    if (!c.session) throw new HttpError(401, "Se requiere acceso.");
    return { kind: c.session.kind, directorId: c.session.director?.id ?? null };
  };
  const requireAny = (c: Ctx) => viewerOf(c);
  const requireOwner = (c: Ctx) => {
    const v = viewerOf(c);
    if (v.kind !== "owner") throw new HttpError(403, "Solo el autor puede hacer esto.");
    return v;
  };
  const whoName = (s: Session) => (s.kind === "owner" ? config.ownerName : s.director!.name);

  /**
   * Same-origin check. Fetch requests carry the real Origin. HTML form posts carry
   * `Origin: null` because of `Referrer-Policy: no-referrer`; for those (and for
   * clients without Origin) Sec-Fetch-Site must say same-origin.
   */
  const sameOrigin = (c: Ctx) => {
    const origin = c.req.headers.origin;
    if (origin !== undefined && origin !== "null") return origin === config.origin;
    return c.req.headers["sec-fetch-site"] === "same-origin";
  };

  const checkCsrf = (c: Ctx, formToken?: string) => {
    if (c.bearer || ["GET", "HEAD"].includes(c.req.method ?? "")) return;
    if (!sameOrigin(c)) throw new HttpError(403, "Origen no permitido.");
    const token = (c.req.headers["x-csrf-token"] as string | undefined) ?? formToken ?? "";
    if (!c.session || !safeEqual(token, c.session.csrf)) throw new HttpError(403, "Token CSRF no válido.");
  };

  const limited = (limiter: RateLimiter, key: string) => {
    const wait = limiter.hit(key);
    if (wait > 0) throw new HttpError(429, "Demasiados intentos. Espere un momento.", { "retry-after": String(wait) });
  };

  const layout = (c: Ctx, title: string): pages.Layout => ({
    title,
    who: c.session ? { kind: c.session.kind, name: whoName(c.session) } : null,
    csrf: c.session?.csrf,
  });

  const getVersionOr404 = async (n: number | null): Promise<Version> => {
    const v = n === null ? null : await repo.getVersion(n);
    if (!v) throw new HttpError(404, "No existe esa versión.");
    return v;
  };

  const diffFor = async (v: Version): Promise<VersionDiff | null> => {
    if (diffCache.has(v.id)) return diffCache.get(v.id)!;
    const all = await repo.listVersions();
    const prev = all.find((x) => x.number < v.number) ?? null;
    let d: VersionDiff | null = null;
    if (prev) {
      d = diffVersions(
        { number: prev.number, pages: await repo.pages(prev.id), avance: prev.avance, chapters: prev.chapter_pages },
        { pages: await repo.pages(v.id), avance: v.avance, chapters: v.chapter_pages },
      );
    }
    if (diffCache.size > 20) diffCache.clear();
    diffCache.set(v.id, d);
    return d;
  };

  /** A thread, if the viewer may see it (visibility setting applies to directors). */
  const visibleThread = async (c: Ctx, id: number | null) => {
    if (id === null) throw new HttpError(404, "No existe ese hilo.");
    const [t] = await repo.listThreads(viewerOf(c), { threadId: id });
    if (!t) throw new HttpError(404, "No existe ese hilo.");
    return t;
  };

  const notifyComment = (threadId: number, commentId: number) => {
    // After the response: notifications never delay or fail a request.
    setImmediate(async () => {
      try {
        const [t] = await repo.listThreads({ kind: "owner", directorId: null }, { threadId });
        if (t) await notifier.commentCreated(t, commentId);
      } catch (e) {
        log(`notify error: ${(e as Error).message}`);
      }
    });
  };

  // --- public routes ---

  route("GET", "/healthz", async (c) => {
    await repo.db.query("select 1");
    send(c.res, 200, "ok", "text/plain; charset=utf-8");
  });

  const serveFile = async (c: Ctx, root: string, rel: string, maxAge: number) => {
    const path = normalize(join(root, rel));
    if (!path.startsWith(root + sep)) throw new HttpError(404, "No encontrado.");
    const type = MIME[extname(path)];
    if (!type) throw new HttpError(404, "No encontrado.");
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new HttpError(404, "No encontrado.");
    }
    send(c.res, 200, data, type, { "cache-control": `public, max-age=${maxAge}` });
  };

  route("GET", "/static/(.+)", async (c) => serveFile(c, PUBLIC_DIR, c.params[0]!, 300));

  const VENDOR: Record<string, string> = {
    // The legacy build carries polyfills: directors may have older browsers.
    "pdf.mjs": "legacy/build/pdf.min.mjs",
    "pdf.worker.mjs": "legacy/build/pdf.worker.min.mjs",
  };
  route("GET", "/vendor/pdfjs/(.+)", async (c) => {
    const rel = c.params[0]!;
    const mapped = VENDOR[rel] ?? (/^(cmaps|standard_fonts|wasm|iccs)\/[\w.-]+$/.test(rel) ? rel : null);
    if (!mapped) throw new HttpError(404, "No encontrado.");
    await serveFile(c, PDFJS_DIR, mapped, 86400);
  });

  route("GET", "/favicon.ico", async (c) => redirect(c.res, "/static/favicon.svg"));

  route("GET", "/", async (c) => {
    if (!c.session) return html(c.res, 200, pages.landingPage());
    if (c.session.kind === "director") {
      const latest = await repo.latestVersion();
      if (!latest) {
        return html(c.res, 200, pages.page(layout(c, "Revisión de tesis"), `<main class="narrow"><h1>Bienvenido(a), ${esc(whoName(c.session))}</h1><p>Aún no hay ninguna versión publicada. Recibirá un aviso cuando la haya.</p></main>`));
      }
      return redirect(c.res, `/v/${latest.number}`);
    }
    const versions = await repo.listVersions();
    const open = await repo.listThreads({ kind: "owner", directorId: null }, { status: "open" });
    const openByVersion = new Map<number, number>();
    for (const t of open) openByVersion.set(t.version, (openByVersion.get(t.version) ?? 0) + 1);
    const en = notifier.enabled;
    html(
      c.res,
      200,
      pages.ownerDashboard(layout(c, "Tu tesis"), {
        versions,
        openByVersion,
        directors: await repo.listDirectors(),
        visibility: await repo.visibility(),
        channels: {
          ...en,
          digest: config.digestHour === null ? null : `todos los días a las ${config.digestHour}:00 (${config.timeZone})`,
        },
        publicUrl: config.publicUrl,
        maxPdfMb: Math.round(config.maxPdfBytes / 1024 / 1024),
      }),
    );
  });

  // Director link: create a session, then leave the secret URL behind.
  route("GET", "/acceso/:secret", async (c) => {
    limited(linkLimiter, c.ip);
    const director = await repo.directorByLink(decodeURIComponent(c.params[0]!));
    if (!director) {
      return html(c.res, 404, pages.messagePage("Enlace no válido", "Este enlace no es válido o fue revocado. Pida un enlace nuevo al autor de la tesis."));
    }
    if (c.session) await repo.deleteSession(c.session.idHash);
    const s = await repo.createSession("director", director.id, DIRECTOR_TTL);
    log(`director session created for director #${director.id}`);
    redirect(c.res, "/", { "set-cookie": cookie(SESSION_COOKIE, s.id, DIRECTOR_TTL / 1000) });
  });

  route("GET", "/entrar", async (c) => {
    if (c.session?.kind === "owner") return redirect(c.res, "/");
    const pre = newSecret(24);
    html(c.res, 200, pages.loginPage(pre), { "set-cookie": cookie(PRE_COOKIE, pre, 3600) });
  });

  route("POST", "/entrar", async (c) => {
    limited(loginLimiter, c.ip);
    if (!sameOrigin(c)) throw new HttpError(403, "Origen no permitido.");
    const form = await readForm(c.req);
    const pre = parseCookies(c.req.headers.cookie).get(PRE_COOKIE) ?? "";
    if (!pre || !safeEqual(form.get("_csrf") ?? "", pre)) throw new HttpError(403, "Formulario caducado. Vuelva a cargar la página.");
    if (!ownerTokenOk(form.get("token") ?? "")) {
      log(`owner login failed from ${c.ip}`);
      const fresh = newSecret(24);
      return html(c.res, 401, pages.loginPage(fresh, "Token incorrecto."), { "set-cookie": cookie(PRE_COOKIE, fresh, 3600) });
    }
    if (c.session) await repo.deleteSession(c.session.idHash);
    const s = await repo.createSession("owner", null, OWNER_TTL);
    log("owner session created");
    redirect(c.res, "/", {
      "set-cookie": [cookie(SESSION_COOKIE, s.id, OWNER_TTL / 1000), cookie(PRE_COOKIE, "", 0)],
    });
  });

  route("POST", "/salir", async (c) => {
    if (c.session) {
      const form = await readForm(c.req);
      checkCsrf(c, form.get("_csrf") ?? "");
      await repo.deleteSession(c.session.idHash);
    }
    redirect(c.res, "/", { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  });

  // --- pages that need a session ---

  route("GET", "/v/latest", async (c) => {
    requireAny(c);
    const v = await repo.latestVersion();
    if (!v) throw new HttpError(404, "Aún no hay versiones.");
    redirect(c.res, `/v/${v.number}`);
  });

  route("GET", "/v/:n", async (c) => {
    requireAny(c);
    const v = await getVersionOr404(toInt(c.params[0]));
    html(c.res, 200, pages.viewerPage(layout(c, `Tesis · versión ${v.number}`), v, await repo.listVersions()));
  });

  route("GET", "/v/:n/cambios", async (c) => {
    requireAny(c);
    const v = await getVersionOr404(toInt(c.params[0]));
    const all = await repo.listVersions();
    const prev = all.find((x) => x.number < v.number) ?? null;
    html(c.res, 200, pages.changesPage(layout(c, `Versión ${v.number}: cambios`), v, prev, await diffFor(v)));
  });

  // --- API ---

  const versionJson = (v: Version) => ({
    number: v.number,
    title: v.title,
    note: v.note,
    page_count: v.page_count,
    pdf_size: v.pdf_size,
    pdf_sha256: v.pdf_sha256,
    created_at: new Date(v.created_at).toISOString(),
    avance: v.avance,
    chapters: v.chapter_pages,
  });

  route("GET", "/api/me", async (c) => {
    const v = requireAny(c);
    json(c.res, 200, { kind: v.kind, name: whoName(c.session!), director_id: v.directorId, csrf: c.bearer ? undefined : c.session!.csrf });
  });

  route("GET", "/api/versions", async (c) => {
    requireAny(c);
    json(c.res, 200, { versions: (await repo.listVersions()).map(versionJson) });
  });

  route("POST", "/api/versions", async (c) => {
    requireOwner(c);
    checkCsrf(c);
    const form = await readMultipart(c.req, config.maxPdfBytes + 2 * 1024 * 1024);
    const pdf = form.get("pdf");
    const avanceFile = form.get("avance");
    if (!(pdf instanceof Blob)) throw new HttpError(400, "Falta el PDF (campo pdf).");
    if (!(avanceFile instanceof Blob)) throw new HttpError(400, "Falta avance.json (campo avance).");
    if (pdf.size > config.maxPdfBytes) throw new HttpError(413, `El PDF supera ${Math.round(config.maxPdfBytes / 1048576)} MB.`);
    if (avanceFile.size > 1024 * 1024) throw new HttpError(413, "avance.json supera 1 MB.");
    const noteRaw = form.get("note");
    const note = str(typeof noteRaw === "string" ? noteRaw : "", "La nota", 5000);
    let avance;
    try {
      avance = validateAvance(JSON.parse(await avanceFile.text()));
    } catch (e) {
      if (e instanceof ValidationError) throw new HttpError(400, e.message);
      throw new HttpError(400, "avance.json no es JSON válido.");
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
    const chapterPages = locateChapters(extracted.pages, avance);
    const key = `pdf/${sha}.pdf`;
    await store.put(key, data, "application/pdf");
    const v = await repo.createVersion({
      title: avance.title,
      note,
      pdfKey: () => key,
      pdfSha256: sha,
      pdfSize: data.length,
      pages: extracted.pages,
      avance,
      chapterPages,
    });
    log(`version ${v.number} published (${extracted.pageCount} pages, ${data.length} bytes)`);
    setImmediate(async () => {
      try {
        await notifier.versionPublished(v, await repo.listDirectors());
      } catch (e) {
        log(`notify error: ${(e as Error).message}`);
      }
    });
    json(c.res, 201, { version: versionJson(v), url: `${config.publicUrl}/v/${v.number}` });
  });

  route("GET", "/api/versions/latest", async (c) => {
    requireAny(c);
    const v = await repo.latestVersion();
    if (!v) throw new HttpError(404, "Aún no hay versiones.");
    json(c.res, 200, { version: versionJson(v) });
  });

  route("GET", "/api/versions/:n", async (c) => {
    requireAny(c);
    json(c.res, 200, { version: versionJson(await getVersionOr404(toInt(c.params[0]))) });
  });

  route("GET", "/api/versions/:n/diff", async (c) => {
    requireAny(c);
    json(c.res, 200, { diff: await diffFor(await getVersionOr404(toInt(c.params[0]))) });
  });

  route("GET", "/api/versions/:n/pdf", async (c) => {
    requireAny(c);
    const v = await getVersionOr404(toInt(c.params[0]));
    const data = await store.get(v.pdf_key);
    if (!data) throw new HttpError(404, "El PDF de esta versión no está en el almacenamiento.");
    send(c.res, 200, data, "application/pdf", {
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="tesis-v${v.number}.pdf"`,
      etag: `"${v.pdf_sha256}"`,
    });
  });

  route("GET", "/api/threads", async (c) => {
    const viewer = requireAny(c);
    const version = c.url.searchParams.get("version");
    const status = c.url.searchParams.get("status");
    let versionNumber: number | undefined;
    if (version === "latest") versionNumber = (await repo.latestVersion())?.number ?? -1;
    else if (version) versionNumber = toInt(version) ?? -1;
    if (status && status !== "open" && status !== "resolved" && status !== "all") throw new HttpError(400, "status: open, resolved o all.");
    const threads = await repo.listThreads(viewer, {
      versionNumber,
      status: status === "open" || status === "resolved" ? status : undefined,
    });
    json(c.res, 200, {
      threads: threads.map((t) => ({ ...t, url: `${config.publicUrl}/v/${t.version}#hilo-${t.id}` })),
    });
  });

  route("GET", "/api/threads/:id", async (c) => {
    const t = await visibleThread(c, toInt(c.params[0]));
    json(c.res, 200, { thread: { ...t, url: `${config.publicUrl}/v/${t.version}#hilo-${t.id}` } });
  });

  route("POST", "/api/threads", async (c) => {
    const viewer = requireAny(c);
    checkCsrf(c);
    limited(writeLimiter, `w:${c.session!.idHash}`);
    const b = await readJson(c.req);
    const v = await getVersionOr404(typeof b.version === "number" ? b.version : null);
    const page = typeof b.page === "number" && Number.isInteger(b.page) ? b.page : 0;
    if (page < 1 || page > v.page_count) throw new HttpError(400, "Página fuera del documento.");
    const anchor = b.anchor === "point" ? "point" : b.anchor === "text" ? "text" : null;
    if (!anchor) throw new HttpError(400, "anchor debe ser text o point.");
    const quote = str(b.quote, "La cita", 2000, { required: anchor === "text" });
    const rects = parseRects(b.rects);
    const body = str(b.body, "El comentario", 10_000, { required: true });
    const id = await repo.createThread(v, { page, anchor, quote: anchor === "text" ? quote : "", rects, body }, viewer);
    const t = await visibleThread(c, id);
    notifyComment(id, t.comments[0]!.id);
    json(c.res, 201, { thread: { ...t, url: `${config.publicUrl}/v/${t.version}#hilo-${t.id}` } });
  });

  route("POST", "/api/threads/:id/comments", async (c) => {
    const viewer = requireAny(c);
    checkCsrf(c);
    limited(writeLimiter, `w:${c.session!.idHash}`);
    const t = await visibleThread(c, toInt(c.params[0]));
    const b = await readJson(c.req);
    const body = str(b.body, "La respuesta", 10_000, { required: true });
    const commentId = await repo.addReply(t.id, body, viewer);
    notifyComment(t.id, commentId);
    json(c.res, 201, { thread: await visibleThread(c, t.id), comment_id: commentId });
  });

  const setStatus = (status: "open" | "resolved") => async (c: Ctx) => {
    requireAny(c);
    checkCsrf(c);
    const t = await visibleThread(c, toInt(c.params[0]));
    await repo.setStatus(t.id, status, whoName(c.session!));
    json(c.res, 200, { thread: await visibleThread(c, t.id) });
  };
  route("POST", "/api/threads/:id/resolve", setStatus("resolved"));
  route("POST", "/api/threads/:id/reopen", setStatus("open"));

  const ownComment = async (c: Ctx) => {
    const viewer = requireAny(c);
    checkCsrf(c);
    const id = toInt(c.params[0]);
    const comment = id === null ? null : await repo.getComment(id);
    if (!comment || comment.deleted_at) throw new HttpError(404, "No existe ese comentario.");
    await visibleThread(c, comment.thread_id);
    const mine = comment.author_kind === viewer.kind && (viewer.kind === "owner" || comment.director_id === viewer.directorId);
    if (!mine) throw new HttpError(403, "Solo puede modificar sus propios comentarios.");
    return comment;
  };

  route("PATCH", "/api/comments/:id", async (c) => {
    const comment = await ownComment(c);
    const b = await readJson(c.req);
    await repo.editComment(comment.id, str(b.body, "El comentario", 10_000, { required: true }));
    json(c.res, 200, { thread: await visibleThread(c, comment.thread_id) });
  });

  route("DELETE", "/api/comments/:id", async (c) => {
    const comment = await ownComment(c);
    await repo.deleteComment(comment.id);
    json(c.res, 200, { thread: await visibleThread(c, comment.thread_id) });
  });

  // --- owner administration ---

  const directorJson = (d: Awaited<ReturnType<Repo["listDirectors"]>>[number]) => ({
    ...d,
    active: d.revoked_at === null,
  });
  const linkOf = (secret: string) => `${config.publicUrl}/acceso/${secret}`;

  route("GET", "/api/directors", async (c) => {
    requireOwner(c);
    json(c.res, 200, { directors: (await repo.listDirectors()).map(directorJson) });
  });

  const emailField = (v: unknown) => {
    const e = str(v, "El correo", 320);
    if (e && !isEmail(e)) throw new HttpError(400, "El correo no es válido.");
    return e || null;
  };

  const maybeSendLink = async (d: Awaited<ReturnType<Repo["listDirectors"]>>[number], secret: string, wanted: boolean) => {
    if (!wanted) return { sent: false };
    try {
      await notifier.sendLink(d, linkOf(secret));
      log(`link emailed to director #${d.id}`);
      return { sent: true };
    } catch (e) {
      return { sent: false, error: (e as Error).message };
    }
  };

  route("POST", "/api/directors", async (c) => {
    requireOwner(c);
    checkCsrf(c);
    const b = await readJson(c.req);
    const { director, secret } = await repo.createDirector({
      name: str(b.name, "El nombre", 200, { required: true }),
      role: str(b.role, "El rol", 100),
      email: emailField(b.email),
      notify_versions: b.notify_versions === true,
    });
    log(`director #${director.id} created`);
    const mail = await maybeSendLink(director, secret, b.send_link === true);
    json(c.res, 201, { director: directorJson(director), link: linkOf(secret), email: mail });
  });

  route("PATCH", "/api/directors/:id", async (c) => {
    requireOwner(c);
    checkCsrf(c);
    const id = toInt(c.params[0]);
    const b = await readJson(c.req);
    const patch: Parameters<Repo["updateDirector"]>[1] = {};
    if ("name" in b) patch.name = str(b.name, "El nombre", 200, { required: true });
    if ("role" in b) patch.role = str(b.role, "El rol", 100);
    if ("email" in b) patch.email = emailField(b.email);
    if ("notify_versions" in b) patch.notify_versions = b.notify_versions === true;
    const d = id === null ? null : await repo.updateDirector(id, patch);
    if (!d) throw new HttpError(404, "No existe ese director.");
    json(c.res, 200, { director: directorJson(d) });
  });

  route("POST", "/api/directors/:id/rotate", async (c) => {
    requireOwner(c);
    checkCsrf(c);
    const id = toInt(c.params[0]);
    const b = c.req.headers["content-type"]?.startsWith("application/json") ? await readJson(c.req) : {};
    const r = id === null ? null : await repo.rotateDirector(id);
    if (!r) throw new HttpError(404, "No existe ese director.");
    log(`director #${r.director.id} link rotated`);
    const mail = await maybeSendLink(r.director, r.secret, b.send_link === true);
    json(c.res, 200, { director: directorJson(r.director), link: linkOf(r.secret), email: mail });
  });

  route("POST", "/api/directors/:id/revoke", async (c) => {
    requireOwner(c);
    checkCsrf(c);
    const id = toInt(c.params[0]);
    const d = id === null ? null : await repo.revokeDirector(id);
    if (!d) throw new HttpError(404, "No existe ese director.");
    log(`director #${d.id} revoked`);
    json(c.res, 200, { director: directorJson(d) });
  });

  route("GET", "/api/settings", async (c) => {
    requireOwner(c);
    json(c.res, 200, { settings: { comments_visibility: await repo.visibility() }, notifications: notifier.enabled });
  });

  route("PUT", "/api/settings", async (c) => {
    requireOwner(c);
    checkCsrf(c);
    const b = await readJson(c.req);
    if (b.comments_visibility !== undefined) {
      if (b.comments_visibility !== "all" && b.comments_visibility !== "own") throw new HttpError(400, "comments_visibility: all u own.");
      await repo.setSetting("comments_visibility", b.comments_visibility as Visibility);
    }
    json(c.res, 200, { settings: { comments_visibility: await repo.visibility() } });
  });

  // --- dispatcher ---

  const authenticate = async (c: Ctx) => {
    const auth = c.req.headers.authorization;
    if (auth !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      if (!m || !ownerTokenOk(m[1]!)) {
        limited(bearerLimiter, c.ip);
        throw new HttpError(401, "Token no válido.", { "www-authenticate": 'Bearer realm="revision-tesis"' });
      }
      c.bearer = true;
      c.session = { kind: "owner", director: null, csrf: "", idHash: "" };
      return;
    }
    const sid = parseCookies(c.req.headers.cookie).get(SESSION_COOKIE);
    if (sid) c.session = await repo.getSession(sid, (kind) => (kind === "owner" ? OWNER_TTL : DIRECTOR_TTL));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://x");
    const isStatic = url.pathname.startsWith("/static/") || url.pathname.startsWith("/vendor/");
    if (!isStatic) res.setHeader("cache-control", "no-store");
    const forwarded = config.trustCloudflare ? req.headers["cf-connecting-ip"] : undefined;
    const ip = (typeof forwarded === "string" && forwarded) || req.socket.remoteAddress || "?";
    const c: Ctx = { req, res, url, ip, params: [], session: null, bearer: false };
    const isApi = url.pathname.startsWith("/api/");
    try {
      const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
      let found: Route | undefined;
      let allowed = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        allowed = true;
        if (r.method === method) {
          found = r;
          c.params = m.slice(1);
          break;
        }
      }
      if (!found) throw new HttpError(allowed ? 405 : 404, allowed ? "Método no permitido." : "No encontrado.");
      if (!isStatic && url.pathname !== "/healthz") await authenticate(c);
      await found.handler(c);
    } catch (e) {
      const err = e instanceof HttpError ? e : null;
      if (!err) log(`error ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      const status = err?.status ?? 500;
      const message = err?.message ?? "Error interno.";
      if (res.headersSent) return res.destroy();
      for (const [k, v] of Object.entries(err?.headers ?? {})) res.setHeader(k, v);
      if (isApi) json(res, status, { error: message });
      else if (status === 401) redirect(res, "/");
      else html(res, status, pages.messagePage(status === 404 ? "No encontrado" : "No se pudo completar", message, `<p><a href="/">Volver al inicio</a></p>`));
    }
  };

  return { handle };
}
