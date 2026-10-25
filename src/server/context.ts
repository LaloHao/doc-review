// The request context and the guards every route module uses: who is asking
// (owner via bearer token or session, director via session), CSRF, rate limits.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { VersionDiff } from "../diff.js";
import type { Notifier } from "../notify/notify.js";
import type { Repo, Session, Version, Viewer } from "../repo.js";
import type { BlobStore } from "../storage.js";
import { diffVersions } from "../diff.js";
import { safeEqual, sha256Hex } from "./crypto.js";
import { HttpError } from "./http.js";
import type * as pages from "./pages.js";
import { RateLimiter } from "./ratelimit.js";

export const SESSION_COOKIE = "__Host-dr_session";
export const PRE_COOKIE = "__Host-dr_pre";
export const OWNER_TTL = 30 * 24 * 3600_000;
export const DIRECTOR_TTL = 180 * 24 * 3600_000;

export interface AppDeps {
  config: Config;
  repo: Repo;
  store: BlobStore;
  notifier: Notifier;
  log?: (msg: string) => void;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  params: string[];
  session: Session | null;
  bearer: boolean;
}

/** What route modules get: the dependencies plus shared guards and services. */
export interface App extends Required<AppDeps> {
  limits: {
    link: RateLimiter;
    login: RateLimiter;
    bearer: RateLimiter;
    write: RateLimiter;
  };
  viewerOf(c: Ctx): Viewer;
  requireAny(c: Ctx): Viewer;
  requireOwner(c: Ctx): Viewer;
  whoName(s: Session): string;
  sameOrigin(c: Ctx): boolean;
  checkCsrf(c: Ctx, formToken?: string): void;
  limited(limiter: RateLimiter, key: string): void;
  writeAllowed(viewer: Viewer): Promise<void>;
  layout(c: Ctx, title: string): pages.Layout;
  ownerTokenOk(token: string): boolean;
  /** Runs after the response: notifications never delay or fail a request. */
  later(fn: () => Promise<void>): void;
  diffFor(v: Version): Promise<VersionDiff | null>;
}

export function createAppContext(deps: AppDeps): App {
  const { config, repo } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));
  const limits = {
    link: new RateLimiter(20, 10 * 60_000),
    login: new RateLimiter(10, 10 * 60_000),
    bearer: new RateLimiter(30, 10 * 60_000), // failed bearer attempts
    write: new RateLimiter(60, 60_000),
  };

  const viewerOf = (c: Ctx): Viewer => {
    if (!c.session) throw new HttpError(401, "Se requiere acceso.");
    return { kind: c.session.kind, directorId: c.session.director?.id ?? null };
  };
  const whoName = (s: Session) => (s.kind === "owner" ? config.ownerName : s.director!.name);

  /**
   * Same-origin check. Browsers send the real Origin on fetch requests and, with
   * `Referrer-Policy: same-origin`, on form posts. Some send `Origin: null` (for
   * example from the link page, which is `no-referrer`); for those, and for
   * clients without Origin, Sec-Fetch-Site must say same-origin.
   */
  const sameOrigin = (c: Ctx) => {
    const origin = c.req.headers.origin;
    if (origin !== undefined && origin !== "null") return origin === config.origin;
    return c.req.headers["sec-fetch-site"] === "same-origin";
  };

  const limited = (limiter: RateLimiter, key: string) => {
    const wait = limiter.hit(key);
    if (wait > 0) throw new HttpError(429, "Demasiados intentos. Espere un momento.", { "retry-after": String(wait) });
  };

  /**
   * The diff against the previous version: computed once (right after
   * publishing, or on first use for older versions) and stored with the version.
   */
  const diffsInFlight = new Map<number, Promise<VersionDiff | null>>();
  const diffFor = async (v: Version): Promise<VersionDiff | null> => {
    const stored = await repo.storedDiff(v.id);
    if (stored !== undefined) return stored;
    let p = diffsInFlight.get(v.id);
    if (!p) {
      p = (async () => {
        const all = await repo.listVersions();
        const prev = all.find((x) => x.number < v.number) ?? null;
        const d = prev
          ? diffVersions(
              { number: prev.number, pages: await repo.pages(prev.id), avance: prev.avance, chapters: prev.chapter_pages },
              { pages: await repo.pages(v.id), avance: v.avance, chapters: v.chapter_pages },
            )
          : null;
        await repo.storeDiff(v.id, d);
        return d;
      })().finally(() => diffsInFlight.delete(v.id));
      diffsInFlight.set(v.id, p);
    }
    return p;
  };

  const app: App = {
    ...deps,
    log,
    limits,
    viewerOf,
    requireAny: viewerOf,
    requireOwner(c) {
      const v = viewerOf(c);
      if (v.kind !== "owner") throw new HttpError(403, "Solo el autor puede hacer esto.");
      return v;
    },
    whoName,
    sameOrigin,
    checkCsrf(c, formToken) {
      if (c.bearer || ["GET", "HEAD"].includes(c.req.method ?? "")) return;
      if (!sameOrigin(c)) throw new HttpError(403, "Origen no permitido.");
      const token = (c.req.headers["x-csrf-token"] as string | undefined) ?? formToken ?? "";
      if (!c.session || !safeEqual(token, c.session.csrf)) throw new HttpError(403, "Token CSRF no válido.");
    },
    limited,
    /**
     * New threads and replies: 60 a minute per person (not per session: a new
     * session from the same link doesn't reset it), and a generous daily cap for
     * each director.
     */
    async writeAllowed(viewer) {
      limited(limits.write, viewer.kind === "owner" ? "w:owner" : `w:d${viewer.directorId}`);
      if (viewer.kind === "director" && config.maxDirectorCommentsPerDay > 0) {
        const n = await repo.countDirectorComments(viewer.directorId!, new Date(Date.now() - 24 * 3600_000));
        if (n >= config.maxDirectorCommentsPerDay) {
          throw new HttpError(429, `Llegó al máximo de ${config.maxDirectorCommentsPerDay} comentarios en 24 horas. Intente más tarde.`);
        }
      }
    },
    layout: (c, title) => ({
      title,
      who: c.session ? { kind: c.session.kind, name: whoName(c.session) } : null,
      csrf: c.session?.csrf,
    }),
    ownerTokenOk: (token) => config.ownerTokenSha256 !== "" && safeEqual(sha256Hex(token), config.ownerTokenSha256),
    later: (fn) =>
      setImmediate(async () => {
        try {
          await fn();
        } catch (e) {
          log(`notify error: ${(e as Error).message}`);
        }
      }),
    diffFor,
  };
  return app;
}
