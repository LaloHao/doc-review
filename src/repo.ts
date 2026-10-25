// Data access. All SQL lives here; handlers get plain objects back.

import type { Avance } from "./avance.js";
import type { Db, Queryable } from "./db/db.js";
import { chapterOfPage, type ChapterPages, type VersionDiff } from "./diff.js";
import { newSecret, sha256Hex } from "./server/crypto.js";
import { renderComment } from "./text.js";

export type AuthorKind = "owner" | "director";

/** When a director hears about replies in their threads. */
export type ReplyNotify = "instant" | "daily" | "never";
export const REPLY_NOTIFY: readonly ReplyNotify[] = ["instant", "daily", "never"];

export interface Director {
  id: number;
  name: string;
  role: string;
  email: string | null;
  notify_versions: boolean;
  notify_replies: ReplyNotify;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  last_seen_at: Date | null;
}

export interface Session {
  kind: AuthorKind;
  director: Director | null;
  csrf: string;
  idHash: string;
  /** The expiry was just extended: the cookie's Max-Age should be too. */
  refreshed?: boolean;
}

export interface Version {
  id: number;
  number: number;
  title: string;
  note: string;
  pdf_key: string;
  pdf_sha256: string;
  pdf_size: number;
  page_count: number;
  avance: Avance;
  chapter_pages: ChapterPages[];
  created_at: Date;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewer {
  kind: AuthorKind;
  directorId: number | null;
}

export interface CommentOut {
  id: number;
  author: { kind: AuthorKind; name: string; director_id: number | null };
  body: string | null;
  body_html: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  mine: boolean;
}

export interface ThreadOut {
  id: number;
  version: number;
  page: number;
  anchor: "text" | "point";
  quote: string;
  rects: Rect[];
  status: "open" | "resolved";
  resolved_at: string | null;
  resolved_by: string | null;
  chapter: { id: string; title: string } | null;
  author: { kind: AuthorKind; name: string; director_id: number | null };
  created_at: string;
  updated_at: string;
  /** The viewer may mark it resolved: the owner, or the director who opened it. */
  can_resolve: boolean;
  comments: CommentOut[];
}

export type Visibility = "all" | "own";

const DIRECTOR_COLS =
  "id, name, role, email, notify_versions, notify_replies, created_at, rotated_at, revoked_at, last_seen_at";

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

/** Fingerprint of the owner token hash, stored in owner sessions ("" = no owner access). */
export function ownerSessionFingerprint(ownerTokenSha256: string): string {
  return ownerTokenSha256 ? sha256Hex(`owner-session:${ownerTokenSha256}`).slice(0, 32) : "";
}

export class Repo {
  constructor(
    readonly db: Db,
    private readonly ownerName: string,
    /** `ownerSessionFingerprint` of the current owner token. */
    private readonly ownerFp = "",
  ) {}

  // --- directors ---

  async createDirector(input: {
    name: string;
    role: string;
    email: string | null;
    notify_versions: boolean;
    notify_replies?: ReplyNotify;
  }): Promise<{ director: Director; secret: string }> {
    const secret = newSecret(32);
    const [director] = await this.db.query<Director>(
      `insert into directors (name, role, email, notify_versions, notify_replies, token_hash)
       values ($1, $2, $3, $4, $5, $6) returning ${DIRECTOR_COLS}`,
      [input.name, input.role, input.email, input.notify_versions, input.notify_replies ?? "never", sha256Hex(secret)],
    );
    return { director: director!, secret };
  }

  listDirectors(): Promise<Director[]> {
    return this.db.query<Director>(`select ${DIRECTOR_COLS} from directors order by revoked_at nulls first, id`);
  }

  async getDirector(id: number): Promise<Director | null> {
    const [d] = await this.db.query<Director>(`select ${DIRECTOR_COLS} from directors where id = $1`, [id]);
    return d ?? null;
  }

  async updateDirector(
    id: number,
    patch: Partial<Pick<Director, "name" | "role" | "email" | "notify_versions" | "notify_replies">>,
  ): Promise<Director | null> {
    const cur = await this.getDirector(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const [d] = await this.db.query<Director>(
      `update directors set name = $2, role = $3, email = $4, notify_versions = $5, notify_replies = $6
       where id = $1 returning ${DIRECTOR_COLS}`,
      [id, next.name, next.role, next.email, next.notify_versions, next.notify_replies],
    );
    return d ?? null;
  }

  /** New secret for the link; the old link and its sessions stop working. */
  async rotateDirector(id: number): Promise<{ director: Director; secret: string } | null> {
    const secret = newSecret(32);
    return this.db.tx(async (q) => {
      const [d] = await q.query<Director>(
        `update directors set token_hash = $2, rotated_at = now(), revoked_at = null
         where id = $1 returning ${DIRECTOR_COLS}`,
        [id, sha256Hex(secret)],
      );
      if (!d) return null;
      await q.query("delete from sessions where director_id = $1", [id]);
      return { director: d, secret };
    });
  }

  async revokeDirector(id: number): Promise<Director | null> {
    return this.db.tx(async (q) => {
      const [d] = await q.query<Director>(
        `update directors set revoked_at = coalesce(revoked_at, now()) where id = $1 returning ${DIRECTOR_COLS}`,
        [id],
      );
      await q.query("delete from sessions where director_id = $1", [id]);
      return d ?? null;
    });
  }

  /** Looks a link secret up by its hash (an indexed lookup; the hash is not secret-dependent timing). */
  async directorByLink(secret: string): Promise<Director | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const [d] = await this.db.query<Director>(
      `select ${DIRECTOR_COLS} from directors where token_hash = $1 and revoked_at is null`,
      [sha256Hex(secret)],
    );
    return d ?? null;
  }

  // --- sessions ---

  async createSession(kind: AuthorKind, directorId: number | null, ttlMs: number): Promise<{ id: string; csrf: string }> {
    const id = newSecret(32);
    const csrf = newSecret(32);
    await this.db.query(
      `insert into sessions (id_hash, kind, director_id, csrf_token, expires_at, owner_fp)
       values ($1, $2, $3, $4, $5, $6)`,
      [sha256Hex(id), kind, directorId, csrf, new Date(Date.now() + ttlMs), kind === "owner" ? this.ownerFp : null],
    );
    if (directorId !== null) {
      await this.db.query("update directors set last_seen_at = now() where id = $1", [directorId]);
    }
    return { id, csrf };
  }

  async getSession(id: string, slideFor: (kind: AuthorKind) => number): Promise<Session | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const idHash = sha256Hex(id);
    const [s] = await this.db.query<{
      kind: AuthorKind;
      director_id: number | null;
      csrf_token: string;
      expires_at: Date;
      last_seen_at: Date;
      owner_fp: string | null;
    }>("select kind, director_id, csrf_token, expires_at, last_seen_at, owner_fp from sessions where id_hash = $1", [idHash]);
    if (!s || new Date(s.expires_at).getTime() <= Date.now()) return null;
    if (s.kind === "owner" && (!this.ownerFp || s.owner_fp !== this.ownerFp)) {
      // Opened with an owner token that is no longer the current one.
      await this.deleteSession(idHash);
      return null;
    }
    let director: Director | null = null;
    if (s.kind === "director") {
      director = s.director_id === null ? null : await this.getDirector(s.director_id);
      if (!director || director.revoked_at) return null;
    }
    // Sliding expiry, written at most once an hour.
    let refreshed = false;
    if (Date.now() - new Date(s.last_seen_at).getTime() > 3600_000) {
      refreshed = true;
      await this.db.query("update sessions set last_seen_at = now(), expires_at = $2 where id_hash = $1", [
        idHash,
        new Date(Date.now() + slideFor(s.kind)),
      ]);
      if (director) await this.db.query("update directors set last_seen_at = now() where id = $1", [director.id]);
    }
    return { kind: s.kind, director, csrf: s.csrf_token, idHash, refreshed };
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.db.query("delete from sessions where id_hash = $1", [idHash]);
  }

  async purgeExpiredSessions(): Promise<void> {
    await this.db.query("delete from sessions where expires_at < now()");
  }

  /** Deletes owner sessions opened with another owner token; returns how many. */
  async purgeStaleOwnerSessions(): Promise<number> {
    const rows = await this.db.query(
      "delete from sessions where kind = 'owner' and owner_fp is distinct from $1 returning id_hash",
      [this.ownerFp],
    );
    return rows.length;
  }

  /** "Cerrar todas las sesiones": every owner web session and, optionally, every director session. */
  async closeAllSessions(directorsToo: boolean): Promise<{ owner: number; directors: number }> {
    const owner = await this.db.query("delete from sessions where kind = 'owner' returning id_hash");
    const directors = directorsToo ? await this.db.query("delete from sessions where kind = 'director' returning id_hash") : [];
    return { owner: owner.length, directors: directors.length };
  }

  // --- settings ---

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const [r] = await this.db.query<{ value: T }>("select value from settings where key = $1", [key]);
    return r ? r.value : fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `insert into settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  }

  visibility(): Promise<Visibility> {
    return this.getSetting<Visibility>("comments_visibility", "all");
  }

  // --- versions ---

  async createVersion(input: {
    title: string;
    note: string;
    pdfKey: (n: number) => string;
    pdfSha256: string;
    pdfSize: number;
    pages: string[];
    avance: Avance;
    chapterPages: ChapterPages[];
  }): Promise<Version> {
    return this.db.tx(async (q) => {
      const [{ n } = { n: 1 }] = await q.query<{ n: number }>("select coalesce(max(number), 0) + 1 as n from versions");
      const [v] = await q.query<Version>(
        `insert into versions (number, title, note, pdf_key, pdf_sha256, pdf_size, page_count, avance, chapter_pages)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) returning *`,
        [
          n,
          input.title,
          input.note,
          input.pdfKey(n),
          input.pdfSha256,
          input.pdfSize,
          input.pages.length,
          JSON.stringify(input.avance),
          JSON.stringify(input.chapterPages),
        ],
      );
      for (let i = 0; i < input.pages.length; i += 100) {
        const chunk = input.pages.slice(i, i + 100);
        const values = chunk.map((_, j) => `($1, $${2 * j + 2}, $${2 * j + 3})`).join(", ");
        await q.query(
          `insert into version_pages (version_id, page, text) values ${values}`,
          [v!.id, ...chunk.flatMap((t, j) => [i + j + 1, t])],
        );
      }
      return v!;
    });
  }

  listVersions(): Promise<Version[]> {
    return this.db.query<Version>("select * from versions order by number desc");
  }

  async getVersion(number: number): Promise<Version | null> {
    const [v] = await this.db.query<Version>("select * from versions where number = $1", [number]);
    return v ?? null;
  }

  async latestVersion(): Promise<Version | null> {
    const [v] = await this.db.query<Version>("select * from versions order by number desc limit 1");
    return v ?? null;
  }

  /** The stored diff of a version: undefined if not computed yet (null = first version). */
  async storedDiff(versionId: number): Promise<VersionDiff | null | undefined> {
    const [r] = await this.db.query<{ diff: VersionDiff | null }>("select diff from version_diffs where version_id = $1", [versionId]);
    return r ? r.diff : undefined;
  }

  async storeDiff(versionId: number, diff: VersionDiff | null): Promise<void> {
    await this.db.query("insert into version_diffs (version_id, diff) values ($1, $2::jsonb) on conflict do nothing", [
      versionId,
      JSON.stringify(diff),
    ]);
  }

  async pages(versionId: number): Promise<string[]> {
    const rows = await this.db.query<{ text: string }>(
      "select text from version_pages where version_id = $1 order by page",
      [versionId],
    );
    return rows.map((r) => r.text);
  }

  // --- threads and comments ---

  async createThread(
    version: Version,
    input: { page: number; anchor: "text" | "point"; quote: string; rects: Rect[]; body: string },
    viewer: Viewer,
  ): Promise<number> {
    return this.db.tx(async (q) => {
      const [t] = await q.query<{ id: number }>(
        `insert into threads (version_id, page, anchor, quote, rects, author_kind, director_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7) returning id`,
        [version.id, input.page, input.anchor, input.quote, JSON.stringify(input.rects), viewer.kind, viewer.directorId],
      );
      await q.query("insert into comments (thread_id, author_kind, director_id, body) values ($1, $2, $3, $4)", [
        t!.id,
        viewer.kind,
        viewer.directorId,
        input.body,
      ]);
      return t!.id;
    });
  }

  async addReply(threadId: number, body: string, viewer: Viewer): Promise<number> {
    return this.db.tx(async (q) => {
      const [c] = await q.query<{ id: number }>(
        "insert into comments (thread_id, author_kind, director_id, body) values ($1, $2, $3, $4) returning id",
        [threadId, viewer.kind, viewer.directorId, body],
      );
      await q.query("update threads set updated_at = now() where id = $1", [threadId]);
      return c!.id;
    });
  }

  /** Comments (thread openings included) a director wrote since `since`. */
  async countDirectorComments(directorId: number, since: Date): Promise<number> {
    const [r] = await this.db.query<{ n: number }>(
      "select count(*)::int as n from comments where director_id = $1 and created_at >= $2",
      [directorId, since],
    );
    return r?.n ?? 0;
  }

  async getComment(id: number): Promise<{
    id: number;
    thread_id: number;
    author_kind: AuthorKind;
    director_id: number | null;
    deleted_at: Date | null;
  } | null> {
    const [c] = await this.db.query<{
      id: number;
      thread_id: number;
      author_kind: AuthorKind;
      director_id: number | null;
      deleted_at: Date | null;
    }>("select id, thread_id, author_kind, director_id, deleted_at from comments where id = $1", [id]);
    return c ?? null;
  }

  /** Edits a comment, keeping its previous text (the last 20 versions). Returns the previous text. */
  async editComment(id: number, body: string): Promise<string | null> {
    return this.db.tx(async (q) => {
      const [cur] = await q.query<{ body: string }>("select body from comments where id = $1 and deleted_at is null for update", [id]);
      if (!cur) return null;
      if (cur.body === body) return cur.body;
      await q.query("insert into comment_edits (comment_id, body) values ($1, $2)", [id, cur.body]);
      await q.query(
        `delete from comment_edits where comment_id = $1 and id not in
         (select id from comment_edits where comment_id = $1 order by id desc limit 20)`,
        [id],
      );
      await q.query("update comments set body = $2, edited_at = now() where id = $1", [id, body]);
      return cur.body;
    });
  }

  /** Previous texts of a comment, newest first. */
  commentEdits(id: number): Promise<{ body: string; edited_at: Date }[]> {
    return this.db.query("select body, edited_at from comment_edits where comment_id = $1 order by id desc", [id]);
  }

  /** Soft delete: the row stays (the thread keeps its shape), the text is hidden. */
  async deleteComment(id: number): Promise<void> {
    await this.db.query("update comments set deleted_at = coalesce(deleted_at, now()) where id = $1", [id]);
  }

  async setStatus(threadId: number, status: "open" | "resolved", by: Viewer & { name: string }): Promise<void> {
    const resolved = status === "resolved";
    await this.db.query(
      `update threads set status = $2, resolved_at = ${resolved ? "now()" : "null"},
       resolved_by = $3, resolved_by_kind = $4, resolved_by_director_id = $5, updated_at = now() where id = $1`,
      resolved ? [threadId, status, by.name, by.kind, by.directorId] : [threadId, status, null, null, null],
    );
  }

  /** Threads visible to `viewer`, with their comments. */
  async listThreads(
    viewer: Viewer,
    filter: { versionNumber?: number; status?: "open" | "resolved"; threadId?: number; since?: Date } = {},
  ): Promise<ThreadOut[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (filter.versionNumber !== undefined) where.push(`v.number = ${p(filter.versionNumber)}`);
    if (filter.status) where.push(`t.status = ${p(filter.status)}`);
    if (filter.threadId !== undefined) where.push(`t.id = ${p(filter.threadId)}`);
    // "own": a director sees the threads opened by the owner or by them, and in
    // them only the owner's comments and their own.
    const own = viewer.kind === "director" && (await this.visibility()) === "own";
    if (own) where.push(`(t.author_kind = 'owner' or t.director_id = ${p(viewer.directorId)})`);
    const threads = await this.db.query<{
      id: number;
      number: number;
      page: number;
      anchor: "text" | "point";
      quote: string;
      rects: Rect[];
      status: "open" | "resolved";
      resolved_at: Date | null;
      resolved_by: string | null;
      resolved_by_kind: AuthorKind | null;
      resolved_by_director_id: number | null;
      author_kind: AuthorKind;
      director_id: number | null;
      created_at: Date;
      updated_at: Date;
      chapter_pages: ChapterPages[];
    }>(
      `select t.*, v.number, v.chapter_pages from threads t join versions v on v.id = t.version_id
       ${where.length ? "where " + where.join(" and ") : ""}
       order by v.number desc, t.page, t.id`,
      params,
    );
    if (threads.length === 0) return [];
    const comments = await this.db.query<{
      id: number;
      thread_id: number;
      author_kind: AuthorKind;
      director_id: number | null;
      body: string;
      created_at: Date;
      edited_at: Date | null;
      deleted_at: Date | null;
    }>(
      `select * from comments where thread_id = any($1::int[])
       ${own ? "and (author_kind = 'owner' or director_id = $2)" : ""} order by created_at, id`,
      own ? [threads.map((t) => t.id), viewer.directorId] : [threads.map((t) => t.id)],
    );
    const names = new Map((await this.listDirectors()).map((d) => [d.id, d.name]));
    const author = (kind: AuthorKind, id: number | null) => ({
      kind,
      director_id: id,
      name: kind === "owner" ? this.ownerName : (names.get(id ?? -1) ?? "Director(a)"),
    });
    const byThread = new Map<number, CommentOut[]>();
    for (const c of comments) {
      const list = byThread.get(c.thread_id) ?? [];
      const deleted = c.deleted_at !== null;
      list.push({
        id: c.id,
        author: author(c.author_kind, c.director_id),
        body: deleted ? null : c.body,
        body_html: deleted ? "<p><em>Comentario eliminado.</em></p>" : renderComment(c.body),
        created_at: iso(c.created_at)!,
        edited_at: iso(c.edited_at),
        deleted,
        mine: c.author_kind === viewer.kind && (viewer.kind === "owner" || c.director_id === viewer.directorId),
      });
      byThread.set(c.thread_id, list);
    }
    const since = filter.since?.getTime();
    const resolvedBy = (t: (typeof threads)[number]): string | null => {
      if (!t.resolved_by || !own) return t.resolved_by;
      if (t.resolved_by_kind === "owner") return t.resolved_by;
      if (t.resolved_by_kind === "director") return t.resolved_by_director_id === viewer.directorId ? t.resolved_by : null;
      return t.resolved_by === this.ownerName ? t.resolved_by : null; // before 002_resolved_by
    };
    return threads
      .map((t): ThreadOut => {
        const ch = chapterOfPage(t.chapter_pages ?? [], t.page);
        return {
          id: t.id,
          version: t.number,
          page: t.page,
          anchor: t.anchor,
          quote: t.quote,
          rects: t.rects,
          status: t.status,
          resolved_at: iso(t.resolved_at),
          resolved_by: resolvedBy(t),
          chapter: ch ? { id: ch.id, title: ch.title } : null,
          author: author(t.author_kind, t.director_id),
          created_at: iso(t.created_at)!,
          updated_at: iso(t.updated_at)!,
          can_resolve:
            viewer.kind === "owner" || (t.author_kind === "director" && t.director_id === viewer.directorId),
          comments: byThread.get(t.id) ?? [],
        };
      })
      .filter((t) => since === undefined || t.comments.some((c) => Date.parse(c.created_at) >= since));
  }

  async threadVersion(threadId: number): Promise<number | null> {
    const [r] = await this.db.query<{ number: number }>(
      "select v.number from threads t join versions v on v.id = t.version_id where t.id = $1",
      [threadId],
    );
    return r?.number ?? null;
  }

  /**
   * What a director hasn't heard about: comments by others since `since`, in the
   * threads they opened or replied to, as that director sees them (visibility
   * setting included).
   */
  async directorUpdates(directorId: number, since: Date): Promise<{ thread: ThreadOut; comment: CommentOut }[]> {
    const threads = await this.listThreads({ kind: "director", directorId }, { since });
    return threads.flatMap((t) =>
      participates(t, directorId)
        ? t.comments
            .filter((c) => !c.deleted && !isBy(c, directorId) && Date.parse(c.created_at) >= since.getTime())
            .map((comment) => ({ thread: t, comment }))
        : [],
    );
  }

  // --- digest bookkeeping (a day is marked only after its digest went out) ---

  async digestDone(day: string): Promise<boolean> {
    return (await this.db.query("select 1 from digest_runs where day = $1", [day])).length > 0;
  }

  async markDigest(day: string): Promise<void> {
    await this.db.query("insert into digest_runs (day) values ($1) on conflict do nothing", [day]);
  }

  async directorDigestDone(directorId: number, day: string): Promise<boolean> {
    return (await this.db.query("select 1 from director_digest_runs where director_id = $1 and day = $2", [directorId, day])).length > 0;
  }

  async markDirectorDigest(directorId: number, day: string): Promise<void> {
    await this.db.query("insert into director_digest_runs (director_id, day) values ($1, $2) on conflict do nothing", [directorId, day]);
  }

  /** When the director's last digest went out. */
  async lastDirectorDigest(directorId: number): Promise<Date | null> {
    const [r] = await this.db.query<{ at: Date | null }>("select max(sent_at) as at from director_digest_runs where director_id = $1", [directorId]);
    return r?.at ? new Date(r.at) : null;
  }
}

const isBy = (c: { author: { kind: AuthorKind; director_id: number | null } }, directorId: number) =>
  c.author.kind === "director" && c.author.director_id === directorId;

/** A director takes part in a thread they opened or replied to. */
export function participates(t: ThreadOut, directorId: number): boolean {
  return isBy(t, directorId) || t.comments.some((c) => isBy(c, directorId));
}

export type { Queryable };
