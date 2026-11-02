// HTTP application: security headers, authentication, the router and error
// handling. The routes live in ./routes, one module per area.
//
// Authentication, checked on every route except the health checks and the
// static files (the landing page, the owner login and the invitation links accept
// requests without a session):
// - Owner via API: `Authorization: Bearer <owner token>` (Emacs, CLI): the
//   bootstrap token (OWNER_TOKEN_SHA256) or a device token. No cookies
//   are read when this header is present, so no CSRF applies.
// - Owner on the web: the token is entered once at the login page → session cookie.
// - Reviewer: an invitation's secret link → session cookie → redirect to a clean URL.
// Cookie-authenticated mutations need Origin == PUBLIC_URL and the session's CSRF
// token in X-CSRF-Token (or the _csrf form field). Cookies are HttpOnly, Secure,
// SameSite=Lax.

import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Config } from "../config.js";
import { translator } from "../i18n/index.js";
import type { Session } from "../repo.js";
import { createAppContext, langOf, OWNER_TTL, REVIEWER_TTL, SESSION_COOKIE, type App, type AppDeps, type Ctx } from "./context.js";
import { cookie, html, HttpError, json, parseCookies, redirect } from "./http.js";
import { messagePage } from "./pages/layout.js";
import { ipBucket } from "./ratelimit.js";
import { Router } from "./router.js";
import { authRoutes, loggablePath } from "./routes/auth.js";
import { deviceRoutes } from "./routes/devices.js";
import { documentRoutes } from "./routes/documents.js";
import { reviewerRoutes } from "./routes/reviewers.js";
import { settingsRoutes } from "./routes/settings.js";
import { isHealthPath, isStaticPath, staticRoutes } from "./routes/static.js";
import { threadRoutes } from "./routes/threads.js";
import { versionRoutes } from "./routes/versions.js";
import { SpanKind, StatusCode } from "../telemetry/index.js";
import { withScope, type Identity } from "../telemetry/scope.js";
import { parseTraceparent } from "../telemetry/trace.js";

export { loggablePath, SESSION_COOKIE };
export type { AppDeps };

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
    // same-origin: form posts carry a real Origin header; nothing leaks to other sites.
    "referrer-policy": "same-origin",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  };
  if (config.publicUrl.startsWith("https://")) h["strict-transport-security"] = "max-age=31536000";
  return h;
}

/**
 * Errors caused by the request rather than the server: malformed URL escapes and
 * Postgres data exceptions (class 22: bad integer, out of range…). They become a
 * 400 and are not logged with a stack trace.
 */
function clientError(e: unknown): HttpError | null {
  if (e instanceof URIError) return new HttpError(400, "err.bad_address");
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("22")) return new HttpError(400, "err.bad_data");
  return null;
}

/** All routes, by area. */
export function buildRouter(app: App): Router<Ctx> {
  const r = new Router<Ctx>();
  staticRoutes(r, app);
  authRoutes(r, app);
  documentRoutes(r, app);
  versionRoutes(r, app);
  threadRoutes(r, app);
  reviewerRoutes(r, app);
  settingsRoutes(r, app);
  deviceRoutes(r, app);
  return r;
}

/** Bearer token or session cookie → c.session. */
async function authenticate(app: App, c: Ctx): Promise<void> {
  const auth = c.req.headers.authorization;
  if (auth !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    const cred = m ? await app.ownerCredential(m[1]!) : null;
    if (!cred) {
      app.log.warn("bearer_rejected", "bearer token rejected", {}, { quietText: true });
      app.limited(app.limits.bearer, ipBucket(c.ip));
      throw new HttpError(401, "err.bad_token", {}, { "www-authenticate": 'Bearer realm="doc-review"' });
    }
    c.bearer = true;
    c.session = { kind: "owner", person: null, csrf: "", idHash: "", deviceId: cred.deviceId };
    app.identify({ actor: "owner", auth: "bearer", device_id: cred.deviceId ?? undefined, device_name: cred.deviceName });
    return;
  }
  const sid = parseCookies(c.req.headers.cookie).get(SESSION_COOKIE);
  const ttl = (kind: Session["kind"]) => (kind === "owner" ? OWNER_TTL : REVIEWER_TTL);
  if (sid) c.session = await app.repo.getSession(sid, ttl);
  if (c.session?.kind === "owner") app.identify({ actor: "owner", auth: "session", device_id: c.session.deviceId ?? undefined });
  else if (c.session?.person) app.identifyPerson(c.session.person);
  // The server extended the session: extend the cookie too (a handler that
  // sets its own cookie replaces this header).
  if (c.session?.refreshed) c.res.setHeader("set-cookie", cookie(SESSION_COOKIE, sid!, ttl(c.session.kind) / 1000));
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Route segment before `:id` → the name of the id in logs and spans. */
const ID_NAMES: Record<string, string> = { threads: "thread_id", comments: "comment_id", people: "person_id", invitations: "invitation_id", devices: "device_id" };

/** Slug, version number and numeric ids of a matched route: never secrets or free text. */
function routeFields(route: string | null, names: string[], params: string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!route) return out;
  const segs = route.split("/");
  names.forEach((name, i) => {
    const v = params[i] ?? "";
    if (name === "slug" && /^[A-Za-z0-9_-]{1,100}$/.test(v)) out.doc = v;
    else if (name === "n" && /^\d{1,9}$/.test(v)) out.version = Number(v);
    else if (name === "id" && /^\d{1,15}$/.test(v)) {
      const before = segs[segs.indexOf(":id") - 1] ?? "";
      out[ID_NAMES[before] ?? "id"] = Number(v);
    }
  });
  return out;
}

export function createApp(deps: AppDeps) {
  const app = createAppContext(deps);
  const sec = securityHeaders(deps.config);
  const router = buildRouter(app);
  const { tracer, metrics } = app.telemetry;
  const log = app.log;
  const scheme = new URL(deps.config.publicUrl).protocol.replace(/:$/, "");

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const t0 = performance.now();
    const method = METHODS.has(req.method ?? "") ? req.method! : "_OTHER";
    for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://x");
    const isStatic = isStaticPath(url.pathname);
    if (!isStatic) res.setHeader("cache-control", "no-store");
    const forwarded = deps.config.trustCloudflare ? req.headers["cf-connecting-ip"] : undefined;
    const ip = (typeof forwarded === "string" && forwarded) || req.socket.remoteAddress || "?";
    const c: Ctx = { req, res, url, ip, params: [], session: null, bearer: false, lang: langOf(req), route: null };
    const isApi = url.pathname.startsWith("/api/");
    const health = isHealthPath(url.pathname);
    // Health probes aren't traced (they would flood the traces); they are counted.
    const span = health
      ? null
      : tracer.startSpan(method, {
          kind: SpanKind.SERVER,
          parent: tracer.enabled ? parseTraceparent(req.headers.traceparent) : null,
          attributes: { "http.request.method": method, "url.scheme": scheme, "network.protocol.version": req.httpVersion },
        });
    const identity: Identity | null = log.identities
      ? { client_ip: ip, user_agent: String(req.headers["user-agent"] ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) }
      : null;
    let names: string[] = [];
    const finish = () => {
      const status = res.statusCode;
      const route = c.route ?? "unmatched";
      const seconds = (performance.now() - t0) / 1000;
      const role = c.session?.kind ?? "anonymous";
      const fields = routeFields(c.route, names, c.params);
      metrics.httpRequest(method, route, status, seconds);
      if (span) {
        span.name = c.route ? `${method} ${c.route}` : method;
        span.setAttributes({ "http.route": c.route ?? undefined, "http.response.status_code": status, "docreview.role": role });
        for (const [k, v] of Object.entries(fields)) span.setAttribute(k === "doc" ? "docreview.document.slug" : `docreview.${k.replace(/_id$/, ".id")}`, v);
        if (status >= 500) span.setStatus(StatusCode.ERROR);
        span.end();
      }
      const ms = Math.round(seconds * 1000);
      log.log(health ? "debug" : "info", "http_request", `${method} ${route} ${status} ${ms}ms`, { method, route, status, duration_ms: ms, role, ...fields }, { quietText: true });
    };
    const serve = async () => {
      try {
        const m = router.match(req.method ?? "GET", url.pathname);
        if ("status" in m) throw new HttpError(m.status, m.status === 405 ? "err.method" : "err.not_found");
        c.params = m.params;
        c.route = m.route;
        names = m.names;
        if (!isStatic && !health) await authenticate(app, c);
        await m.handler(c);
      } catch (e) {
        const err = e instanceof HttpError ? e : clientError(e);
        if (!err) {
          span?.recordException(e);
          log.error("http_error", `error ${method} ${c.route ?? "unmatched"}`, { method, route: c.route ?? "unmatched" }, {
            text: `error ${req.method} ${loggablePath(url.pathname)}: ${(e as Error).stack ?? e}`,
            error: e,
          });
        }
        const status = err?.status ?? 500;
        const tr = translator(c.lang);
        const message = err ? err.text(c.lang) : tr("err.internal");
        if (res.headersSent) return res.destroy();
        for (const [k, v] of Object.entries(err?.headers ?? {})) res.setHeader(k, v);
        if (isApi) json(res, status, { error: message });
        else if (status === 401) redirect(res, "/");
        else html(res, status, messagePage(tr, tr(status === 404 ? "err.page_not_found" : "err.page_failed"), message, `<p><a href="/">${tr.e("common.back_home")}</a></p>`));
      }
    };
    const run = async () => {
      try {
        await serve();
      } finally {
        finish();
      }
    };
    if (span || identity) await withScope({ span, identity }, run);
    else await run();
  };

  return { handle };
}
