// The request context and the guards every route module uses: who is asking
// (the owner via bearer token or session, a reviewer via session), which
// document, CSRF, rate limits, and the shared services (diffs, notifications).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { diffVersions, type VersionDiff } from "../diff.js";
import { negotiate, translator, type Lang, type Tr } from "../i18n/index.js";
import type { Notifier } from "../notify/notify.js";
import type { Document, Invitation, Repo, Session, ThreadOut, Version, Viewer } from "../repo.js";
import type { BlobStore } from "../storage.js";
import { safeEqual, sha256Hex } from "./crypto.js";
import { HttpError } from "./http.js";
import type { Layout } from "./pages/layout.js";
import { RateLimiter } from "./ratelimit.js";

export const SESSION_COOKIE = "__Host-dr_session";
export const PRE_COOKIE = "__Host-dr_pre";
export const OWNER_TTL = 30 * 24 * 3600_000;
export const REVIEWER_TTL = 180 * 24 * 3600_000;

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
  /** From Accept-Language: API messages and pages outside a document. */
  lang: Lang;
}

/** A document the viewer may see, and the reviewer's invitation to it. */
export interface DocAccess {
  doc: Document;
  invitation: Invitation | null;
}

/** What route modules get: the dependencies plus shared guards and services. */
export interface App extends Required<AppDeps> {
  limits: { link: RateLimiter; login: RateLimiter; bearer: RateLimiter; write: RateLimiter };
  viewerOf(c: Ctx): Viewer;
  requireOwner(c: Ctx): Viewer;
  whoName(s: Session): string;
  sameOrigin(c: Ctx): boolean;
  checkCsrf(c: Ctx, formToken?: string): void;
  limited(limiter: RateLimiter, key: string): void;
  writeAllowed(viewer: Viewer): Promise<void>;
  ownerTokenOk(token: string): boolean;
  /** The document of a URL, if the viewer may see it (404 otherwise, for both). */
  documentFor(c: Ctx, slug: string | undefined): Promise<DocAccess>;
  /** Archived documents are read-only. */
  requireWritable(doc: Document): void;
  /** A thread (and its document) if the viewer may see it. */
  threadFor(c: Ctx, threadId: number): Promise<{ doc: Document; thread: ThreadOut }>;
  layout(c: Ctx, tr: Tr, title: string, extra?: Partial<Layout>): Layout;
  /** Runs after the response: notifications never delay or fail a request. */
  later(fn: () => Promise<void>): void;
  diffFor(v: Version): Promise<VersionDiff | null>;
  threadUrl(t: { document: string; version: number; id: number }): string;
  linkOf(secret: string): string;
}

export function langOf(req: IncomingMessage): Lang {
  return negotiate(req.headers["accept-language"]);
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
    if (!c.session) throw new HttpError(401, "err.auth_required");
    return { kind: c.session.kind, personId: c.session.person?.id ?? null };
  };
  const whoName = (s: Session) => (s.kind === "owner" ? config.ownerName : s.person!.name);

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
    if (wait > 0) throw new HttpError(429, "err.rate_limited", {}, { "retry-after": String(wait) });
  };

  const documentFor = async (c: Ctx, slug: string | undefined): Promise<DocAccess> => {
    const viewer = viewerOf(c);
    const doc = slug ? await repo.documentBySlug(slug) : null;
    if (!doc) throw new HttpError(404, "err.no_document");
    if (viewer.kind === "owner") return { doc, invitation: null };
    const invitation = await repo.activeInvitation(viewer.personId!, doc.id);
    if (!invitation) throw new HttpError(404, "err.no_document");
    return { doc, invitation };
  };

  /**
   * The diff against the previous version: computed once (right after
   * publishing, or on first use) and stored with the version.
   */
  const diffsInFlight = new Map<number, Promise<VersionDiff | null>>();
  const diffFor = async (v: Version): Promise<VersionDiff | null> => {
    const stored = await repo.storedDiff(v.id);
    if (stored !== undefined) return stored;
    let p = diffsInFlight.get(v.id);
    if (!p) {
      p = (async () => {
        const prev = await repo.previousVersion(v);
        const d = prev
          ? diffVersions(
              { number: prev.number, pages: await repo.pages(prev.id), progress: prev.progress, sections: prev.section_pages },
              { pages: await repo.pages(v.id), progress: v.progress, sections: v.section_pages },
            )
          : null;
        await repo.storeDiff(v.id, d);
        return d;
      })().finally(() => diffsInFlight.delete(v.id));
      diffsInFlight.set(v.id, p);
    }
    return p;
  };

  return {
    ...deps,
    log,
    limits,
    viewerOf,
    requireOwner(c) {
      const v = viewerOf(c);
      if (v.kind !== "owner") throw new HttpError(403, "err.owner_only");
      return v;
    },
    whoName,
    sameOrigin,
    checkCsrf(c, formToken) {
      if (c.bearer || ["GET", "HEAD"].includes(c.req.method ?? "")) return;
      if (!sameOrigin(c)) throw new HttpError(403, "err.origin");
      const token = (c.req.headers["x-csrf-token"] as string | undefined) ?? formToken ?? "";
      if (!c.session || !safeEqual(token, c.session.csrf)) throw new HttpError(403, "err.csrf");
    },
    limited,
    /**
     * New threads and replies: 60 a minute per person (not per session: a new
     * session from the same link doesn't reset it), and a generous daily cap for
     * each reviewer over all their documents.
     */
    async writeAllowed(viewer) {
      limited(limits.write, viewer.kind === "owner" ? "w:owner" : `w:p${viewer.personId}`);
      if (viewer.kind === "reviewer" && config.maxReviewerCommentsPerDay > 0) {
        const n = await repo.countPersonComments(viewer.personId!, new Date(Date.now() - 24 * 3600_000));
        if (n >= config.maxReviewerCommentsPerDay) throw new HttpError(429, "err.daily_cap", { max: config.maxReviewerCommentsPerDay });
      }
    },
    ownerTokenOk: (token) => config.ownerTokenSha256 !== "" && safeEqual(sha256Hex(token), config.ownerTokenSha256),
    documentFor,
    requireWritable(doc) {
      if (doc.archived_at) throw new HttpError(409, "err.archived");
    },
    async threadFor(c, threadId) {
      const viewer = viewerOf(c);
      const d = await repo.threadDocument(threadId);
      if (!d) throw new HttpError(404, "err.no_thread");
      if (viewer.kind === "reviewer" && !(await repo.activeInvitation(viewer.personId!, d.id))) throw new HttpError(404, "err.no_thread");
      const [thread] = await repo.listThreads(d, viewer, { threadId });
      if (!thread) throw new HttpError(404, "err.no_thread");
      return { doc: d, thread };
    },
    layout: (c, tr, title, extra = {}) => ({
      tr,
      title,
      who: c.session ? { kind: c.session.kind, name: whoName(c.session) } : null,
      csrf: c.session?.csrf,
      ...extra,
    }),
    later: (fn) =>
      setImmediate(async () => {
        try {
          await fn();
        } catch (e) {
          log(`notify error: ${(e as Error).message}`);
        }
      }),
    diffFor,
    threadUrl: (t) => `${config.publicUrl}/d/${t.document}/v/${t.version}#thread-${t.id}`,
    linkOf: (secret) => `${config.publicUrl}/a/${secret}`,
  };
}

/** A translator for a document's pages. */
export const docTr = (doc: Document): Tr => translator(doc.language);
