// Data access. All SQL lives here; handlers get plain objects back.

import type { Db, Queryable } from "./db/db.js";
import { sectionOfPage, type SectionPages, type VersionDiff } from "./diff.js";
import type { Lang } from "./i18n/index.js";
import type { Progress } from "./progress.js";
import { newOwnerToken, newSecret, safeEqual, sha256Hex } from "./server/crypto.js";
import { renderComment } from "./text.js";

export type AuthorKind = "owner" | "reviewer";

/** When a reviewer hears about replies in their threads. */
export type ReplyNotify = "instant" | "daily" | "never";
export const REPLY_NOTIFY: readonly ReplyNotify[] = ["instant", "daily", "never"];

export type Visibility = "all" | "own";
export const VISIBILITIES: readonly Visibility[] = ["all", "own"];

export interface Document {
  id: number;
  slug: string;
  title: string;
  language: Lang;
  visibility: Visibility;
  default_role: string;
  archived_at: Date | null;
  created_at: Date;
}

export interface Person {
  id: number;
  name: string;
  email: string | null;
  notify_versions: boolean;
  notify_replies: ReplyNotify;
  created_at: Date;
  last_seen_at: Date | null;
  /** Archived: every invitation revoked, hidden from the owner's lists. */
  archived_at: Date | null;
}

export interface Invitation {
  id: number;
  document_id: number;
  person_id: number;
  role: string;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  last_seen_at: Date | null;
}

/** An invitation with its person (for a document's reviewer list). */
export interface InvitationWithPerson extends Invitation {
  person: Person;
}

/** An invitation with its document (for a person's list of documents). */
export interface InvitationWithDocument extends Invitation {
  document: Document;
}

export interface Session {
  kind: AuthorKind;
  person: Person | null;
  csrf: string;
  idHash: string;
  /** The expiry was just extended: the cookie's Max-Age should be too. */
  refreshed?: boolean;
  /** Owner sessions: the device they were opened with (null: the bootstrap token). */
  deviceId?: number | null;
}

/** An owner device: a token of its own, a full owner credential. */
export interface OwnerDevice {
  id: number;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  /** The device whose enrollment code created it: its id, or "bootstrap". */
  created_from: string;
}

/**
 * The owner credential a request or a session comes from: the bootstrap token
 * (OWNER_TOKEN_SHA256, deviceId null) or a device, and the fingerprint its
 * sessions carry.
 */
export interface OwnerCredential {
  deviceId: number | null;
  fp: string;
}

const DEVICE_COLS = "id, name, created_at, last_used_at, revoked_at, created_from";

/** `last_used_at` of a device is written at most this often. */
export const DEVICE_TOUCH_MS = 60_000;

export interface Version {
  id: number;
  document_id: number;
  number: number;
  title: string;
  note: string;
  pdf_key: string;
  pdf_sha256: string;
  pdf_size: number;
  page_count: number;
  progress: Progress | null;
  section_pages: SectionPages[];
  created_at: Date;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Who is looking: the owner, or a reviewer (a person). */
export interface Viewer {
  kind: AuthorKind;
  personId: number | null;
}

export const OWNER: Viewer = { kind: "owner", personId: null };

export interface Author {
  kind: AuthorKind;
  name: string;
  person_id: number | null;
  /** The person's role label in this document ("" for none or the owner). */
  role: string;
}

export interface CommentOut {
  id: number;
  author: Author;
  body: string | null;
  body_html: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  mine: boolean;
}

export interface ThreadOut {
  id: number;
  document: string;
  version: number;
  page: number;
  anchor: "text" | "point";
  quote: string;
  rects: Rect[];
  status: "open" | "resolved";
  resolved_at: string | null;
  /** Who resolved it (null when hidden by the visibility setting). */
  resolved_by: string | null;
  section: { id: string; title: string } | null;
  author: Author;
  created_at: string;
  updated_at: string;
  /** The viewer may mark it resolved: the owner, or the reviewer who opened it. */
  can_resolve: boolean;
  comments: CommentOut[];
}

export interface DocumentSummary {
  document: Document;
  latest: Version | null;
  versions: number;
  open_threads: number;
  reviewers: number;
}

const DOC_COLS = "id, slug, title, language, visibility, default_role, archived_at, created_at";
const PERSON_COLS = "id, name, email, notify_versions, notify_replies, created_at, last_seen_at, archived_at";
const INV_COLS = "id, document_id, person_id, role, created_at, rotated_at, revoked_at, last_seen_at";
const prefixed = (cols: string, p: string) =>
  cols
    .split(", ")
    .map((c) => `${p}.${c}`)
    .join(", ");
const aliased = (cols: string, table: string, p: string) =>
  cols
    .split(", ")
    .map((c) => `${table}.${c} as ${p}${c}`)
    .join(", ");

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

/** The `p`-prefixed columns of a joined row, without the prefix. */
function split<T>(row: Record<string, unknown>, p: string): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (k.startsWith(p)) out[k.slice(p.length)] = v;
  return out as T;
}

function inv(r: Record<string, unknown>): Invitation {
  const { id, document_id, person_id, role, created_at, rotated_at, revoked_at, last_seen_at } = r as unknown as Invitation;
  return { id, document_id, person_id, role, created_at, rotated_at, revoked_at, last_seen_at };
}

/** Fingerprint of the owner token hash, stored in owner sessions ("" = no owner access). */
export function ownerSessionFingerprint(ownerTokenSha256: string): string {
  return ownerTokenSha256 ? sha256Hex(`owner-session:${ownerTokenSha256}`).slice(0, 32) : "";
}

/** Link secrets and session ids: 32 random bytes, base64url. */
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export class Repo {
  /** The time, for device and enrollment-code timestamps (tests move it). */
  clock: () => number = Date.now;
  /** When each device's last_used_at was last written (the throttle). */
  private readonly touched = new Map<number, number>();

  constructor(
    readonly db: Db,
    private readonly ownerName: string,
    /** `ownerSessionFingerprint` of the current owner token ("" = owner access off). */
    private readonly ownerFp = "",
  ) {}

  // --- documents ---

  /** Creates a document; null if the slug is taken. */
  async createDocument(input: Pick<Document, "slug" | "title" | "language" | "visibility" | "default_role">): Promise<Document | null> {
    const [d] = await this.db.query<Document>(
      `insert into documents (slug, title, language, visibility, default_role) values ($1, $2, $3, $4, $5)
       on conflict (slug) do nothing returning ${DOC_COLS}`,
      [input.slug, input.title, input.language, input.visibility, input.default_role],
    );
    return d ?? null;
  }

  listDocuments(): Promise<Document[]> {
    return this.db.query<Document>(`select ${DOC_COLS} from documents order by archived_at nulls first, lower(title), id`);
  }

  async documentBySlug(slug: string): Promise<Document | null> {
    if (!/^[a-z0-9-]{1,63}$/.test(slug)) return null;
    const [d] = await this.db.query<Document>(`select ${DOC_COLS} from documents where slug = $1`, [slug]);
    return d ?? null;
  }

  async getDocument(id: number): Promise<Document | null> {
    const [d] = await this.db.query<Document>(`select ${DOC_COLS} from documents where id = $1`, [id]);
    return d ?? null;
  }

  /** Updates a document; "taken" if the new slug belongs to another one. */
  async updateDocument(
    id: number,
    patch: Partial<Pick<Document, "slug" | "title" | "language" | "visibility" | "default_role">>,
  ): Promise<Document | null | "taken"> {
    const cur = await this.getDocument(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    const [d] = await this.db.query<Document>(
      `update documents set slug = $2, title = $3, language = $4, visibility = $5, default_role = $6
       where id = $1 and not exists (select 1 from documents where slug = $2 and id <> $1)
       returning ${DOC_COLS}`,
      [id, n.slug, n.title, n.language, n.visibility, n.default_role],
    );
    return d ?? "taken";
  }

  async setArchived(id: number, archived: boolean): Promise<Document | null> {
    const [d] = await this.db.query<Document>(
      `update documents set archived_at = ${archived ? "coalesce(archived_at, now())" : "null"} where id = $1 returning ${DOC_COLS}`,
      [id],
    );
    return d ?? null;
  }

  /** Documents with their latest version and counts (the owner's dashboard). */
  async documentSummaries(docs?: Document[]): Promise<DocumentSummary[]> {
    const list = docs ?? (await this.listDocuments());
    if (list.length === 0) return [];
    const ids = list.map((d) => d.id);
    const latest = await this.db.query<Version>(
      `select distinct on (document_id) * from versions where document_id = any($1::int[]) order by document_id, number desc`,
      [ids],
    );
    const counts = await this.db.query<{ document_id: number; versions: number; open: number; reviewers: number }>(
      `select d.id as document_id,
              (select count(*)::int from versions v where v.document_id = d.id) as versions,
              (select count(*)::int from threads t where t.document_id = d.id and t.status = 'open') as open,
              (select count(*)::int from invitations i where i.document_id = d.id and i.revoked_at is null) as reviewers
       from documents d where d.id = any($1::int[])`,
      [ids],
    );
    const byDoc = new Map(latest.map((v) => [v.document_id, v]));
    const countBy = new Map(counts.map((c) => [c.document_id, c]));
    return list.map((document) => ({
      document,
      latest: byDoc.get(document.id) ?? null,
      versions: countBy.get(document.id)?.versions ?? 0,
      open_threads: countBy.get(document.id)?.open ?? 0,
      reviewers: countBy.get(document.id)?.reviewers ?? 0,
    }));
  }

  // --- people ---

  async createPerson(input: Pick<Person, "name" | "email"> & Partial<Pick<Person, "notify_versions" | "notify_replies">>): Promise<Person> {
    const [p] = await this.db.query<Person>(
      `insert into people (name, email, notify_versions, notify_replies) values ($1, $2, $3, $4) returning ${PERSON_COLS}`,
      [input.name, input.email, input.notify_versions ?? false, input.notify_replies ?? "never"],
    );
    return p!;
  }

  /** People, by name; archived ones only when asked. */
  listPeople(opts: { archived?: boolean } = {}): Promise<Person[]> {
    return this.db.query<Person>(
      `select ${PERSON_COLS} from people ${opts.archived ? "" : "where archived_at is null"} order by lower(name), id`,
    );
  }

  async getPerson(id: number): Promise<Person | null> {
    const [p] = await this.db.query<Person>(`select ${PERSON_COLS} from people where id = $1`, [id]);
    return p ?? null;
  }

  async updatePerson(id: number, patch: Partial<Pick<Person, "name" | "email" | "notify_versions" | "notify_replies">>): Promise<Person | null> {
    const cur = await this.getPerson(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    const [p] = await this.db.query<Person>(
      `update people set name = $2, email = $3, notify_versions = $4, notify_replies = $5 where id = $1 returning ${PERSON_COLS}`,
      [id, n.name, n.email, n.notify_versions, n.notify_replies],
    );
    return p ?? null;
  }

  /** Comments (deleted ones too) written by the person: they can't be deleted then. */
  async personComments(id: number): Promise<number> {
    const [r] = await this.db.query<{ n: number }>("select count(*)::int as n from comments where person_id = $1", [id]);
    return r?.n ?? 0;
  }

  /**
   * Deletes a person who never wrote a comment, with their invitations and
   * sessions. "has_comments" if they did (archive them instead).
   */
  async deletePerson(id: number): Promise<"deleted" | "not_found" | "has_comments"> {
    return this.db.tx(async (q) => {
      const [p] = await q.query<{ id: number }>("select id from people where id = $1 for update", [id]);
      if (!p) return "not_found";
      const [used] = await q.query<{ x: number }>(
        `select 1 as x where exists (select 1 from comments where person_id = $1)
            or exists (select 1 from threads where person_id = $1 or resolved_by_person_id = $1)`,
        [id],
      );
      if (used) return "has_comments";
      const invs = "select id from invitations where person_id = $1";
      await q.query(`delete from reviewer_digest_runs where invitation_id in (${invs})`, [id]);
      await q.query(`delete from sessions where id_hash in (select session_id_hash from session_invitations where invitation_id in (${invs}))`, [id]);
      await q.query("delete from sessions where person_id = $1", [id]);
      await q.query("delete from invitations where person_id = $1", [id]);
      await q.query("delete from people where id = $1", [id]);
      return "deleted";
    });
  }

  /**
   * Archives a person (or brings them back, `archived` false): archiving revokes
   * every invitation and ends their sessions. Unarchiving leaves the invitations
   * revoked; each one is reactivated with a new link.
   */
  async setPersonArchived(id: number, archived: boolean): Promise<Person | null> {
    return this.db.tx(async (q) => {
      const [p] = await q.query<Person>(
        `update people set archived_at = ${archived ? "coalesce(archived_at, now())" : "null"} where id = $1 returning ${PERSON_COLS}`,
        [id],
      );
      if (!p) return null;
      if (archived) {
        await q.query("update invitations set revoked_at = coalesce(revoked_at, now()) where person_id = $1", [id]);
        await q.query("delete from sessions where person_id = $1", [id]);
      }
      return p;
    });
  }

  // --- invitations ---

  /** Invites a person to a document; null if they already have an invitation there. */
  async createInvitation(documentId: number, personId: number, role: string): Promise<{ invitation: Invitation; secret: string } | null> {
    const secret = newSecret(32);
    const [i] = await this.db.query<Invitation>(
      `insert into invitations (document_id, person_id, role, token_hash) values ($1, $2, $3, $4)
       on conflict (document_id, person_id) do nothing returning ${INV_COLS}`,
      [documentId, personId, role, sha256Hex(secret)],
    );
    return i ? { invitation: i, secret } : null;
  }

  async getInvitation(id: number): Promise<Invitation | null> {
    const [i] = await this.db.query<Invitation>(`select ${INV_COLS} from invitations where id = $1`, [id]);
    return i ?? null;
  }

  /** A document's invitations with their people, active ones first. */
  async invitationsOfDocument(documentId: number): Promise<InvitationWithPerson[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `select ${prefixed(INV_COLS, "i")}, ${aliased(PERSON_COLS, "p", "p_")} from invitations i join people p on p.id = i.person_id
       where i.document_id = $1 order by i.revoked_at nulls first, lower(p.name), i.id`,
      [documentId],
    );
    return rows.map((r) => ({ ...inv(r), person: split<Person>(r, "p_") }));
  }

  /** A person's invitations with their documents. */
  async invitationsOfPerson(personId: number, opts: { activeOnly?: boolean } = {}): Promise<InvitationWithDocument[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `select ${prefixed(INV_COLS, "i")}, ${aliased(DOC_COLS, "d", "d_")} from invitations i join documents d on d.id = i.document_id
       where i.person_id = $1 ${opts.activeOnly ? "and i.revoked_at is null" : ""}
       order by d.archived_at nulls first, lower(d.title), d.id`,
      [personId],
    );
    return rows.map((r) => ({ ...inv(r), document: split<Document>(r, "d_") }));
  }

  /** Every invitation with its person (the owner's people list). */
  async allInvitations(): Promise<InvitationWithDocument[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `select ${prefixed(INV_COLS, "i")}, ${aliased(DOC_COLS, "d", "d_")} from invitations i join documents d on d.id = i.document_id
       order by d.archived_at nulls first, lower(d.title), i.id`,
    );
    return rows.map((r) => ({ ...inv(r), document: split<Document>(r, "d_") }));
  }

  /** The person's active invitation to a document, if any. */
  async activeInvitation(personId: number, documentId: number): Promise<Invitation | null> {
    const [i] = await this.db.query<Invitation>(
      `select ${INV_COLS} from invitations where person_id = $1 and document_id = $2 and revoked_at is null`,
      [personId, documentId],
    );
    return i ?? null;
  }

  async setInvitationRole(id: number, role: string): Promise<Invitation | null> {
    const [i] = await this.db.query<Invitation>(`update invitations set role = $2 where id = $1 returning ${INV_COLS}`, [id, role]);
    return i ?? null;
  }

  /**
   * New secret for the link; the old link and every session opened with it stop
   * working (a leaked link is the reason to rotate). A revoked invitation is
   * reactivated.
   */
  async rotateInvitation(id: number): Promise<{ invitation: Invitation; secret: string } | null> {
    const secret = newSecret(32);
    return this.db.tx(async (q) => {
      const [i] = await q.query<Invitation>(
        `update invitations set token_hash = $2, rotated_at = now(), revoked_at = null where id = $1 returning ${INV_COLS}`,
        [id, sha256Hex(secret)],
      );
      if (!i) return null;
      await q.query("delete from sessions where id_hash in (select session_id_hash from session_invitations where invitation_id = $1)", [id]);
      return { invitation: i, secret };
    });
  }

  /**
   * Revokes the access to the document at once. Sessions opened only with
   * revoked links end; one also opened with another link of the same person
   * keeps that person's other documents.
   */
  async revokeInvitation(id: number): Promise<Invitation | null> {
    return this.db.tx(async (q) => {
      const [i] = await q.query<Invitation>(
        `update invitations set revoked_at = coalesce(revoked_at, now()) where id = $1 returning ${INV_COLS}`,
        [id],
      );
      if (!i) return null;
      await q.query(
        `delete from sessions s where s.id_hash in (select session_id_hash from session_invitations where invitation_id = $1)
         and not exists (select 1 from session_invitations si join invitations o on o.id = si.invitation_id
                         where si.session_id_hash = s.id_hash and o.revoked_at is null)`,
        [id],
      );
      return i;
    });
  }

  /** Looks a link secret up by its hash (an indexed lookup; the hash is not secret-dependent timing). */
  async invitationByLink(secret: string): Promise<{ invitation: Invitation; person: Person; document: Document } | null> {
    if (!SECRET_RE.test(secret)) return null;
    const [r] = await this.db.query<Record<string, unknown>>(
      `select ${prefixed(INV_COLS, "i")}, ${aliased(PERSON_COLS, "p", "p_")}, ${aliased(DOC_COLS, "d", "d_")}
       from invitations i join people p on p.id = i.person_id join documents d on d.id = i.document_id
       where i.token_hash = $1 and i.revoked_at is null`,
      [sha256Hex(secret)],
    );
    return r ? { invitation: inv(r), person: split<Person>(r, "p_"), document: split<Document>(r, "d_") } : null;
  }

  // --- sessions ---

  /**
   * A new session. Owner sessions remember the credential they were opened
   * with (`owner`; the bootstrap token by default): rotating that token or
   * revoking that device ends them.
   */
  async createSession(
    kind: AuthorKind,
    personId: number | null,
    ttlMs: number,
    invitationId?: number,
    owner: OwnerCredential = { deviceId: null, fp: this.ownerFp },
  ): Promise<{ id: string; csrf: string; idHash: string }> {
    const id = newSecret(32);
    const csrf = newSecret(32);
    const idHash = sha256Hex(id);
    const isOwner = kind === "owner";
    await this.db.tx(async (q) => {
      await q.query(
        `insert into sessions (id_hash, kind, person_id, csrf_token, expires_at, owner_fp, owner_device_id) values ($1, $2, $3, $4, $5, $6, $7)`,
        [idHash, kind, personId, csrf, new Date(Date.now() + ttlMs), isOwner ? owner.fp : null, isOwner ? owner.deviceId : null],
      );
      if (invitationId !== undefined) await grant(q, idHash, invitationId);
    });
    return { id, csrf, idHash };
  }

  /** Another link of the same person, opened in a browser that has their session. */
  async addSessionInvitation(idHash: string, invitationId: number): Promise<void> {
    await this.db.tx((q) => grant(q, idHash, invitationId));
  }

  async getSession(id: string, slideFor: (kind: AuthorKind) => number): Promise<Session | null> {
    if (!SECRET_RE.test(id)) return null;
    const idHash = sha256Hex(id);
    const [s] = await this.db.query<{
      kind: AuthorKind;
      person_id: number | null;
      csrf_token: string;
      expires_at: Date;
      last_seen_at: Date;
      owner_fp: string | null;
      owner_device_id: number | null;
    }>("select kind, person_id, csrf_token, expires_at, last_seen_at, owner_fp, owner_device_id from sessions where id_hash = $1", [idHash]);
    if (!s || new Date(s.expires_at).getTime() <= Date.now()) return null;
    if (s.kind === "owner") {
      // The credential it was opened with must still be valid: the current
      // bootstrap token, or a device that isn't revoked (and owner access on).
      let ok = false;
      if (this.ownerFp && s.owner_device_id === null) ok = s.owner_fp === this.ownerFp;
      else if (this.ownerFp) {
        const [d] = await this.db.query<{ token_hash: string }>("select token_hash from owner_devices where id = $1 and revoked_at is null", [s.owner_device_id]);
        ok = d !== undefined && s.owner_fp === ownerSessionFingerprint(d.token_hash);
      }
      if (!ok) {
        await this.deleteSession(idHash);
        return null;
      }
      if (s.owner_device_id !== null) await this.touchDevice(s.owner_device_id);
    }
    let person: Person | null = null;
    if (s.kind === "reviewer") {
      person = s.person_id === null ? null : await this.getPerson(s.person_id);
      if (!person) return null;
      // At least one of the links it was opened with must still be active.
      const ok = await this.db.query(
        `select 1 from session_invitations si join invitations i on i.id = si.invitation_id
         where si.session_id_hash = $1 and i.revoked_at is null limit 1`,
        [idHash],
      );
      if (ok.length === 0) return null;
    }
    // Sliding expiry, written at most once an hour.
    let refreshed = false;
    if (Date.now() - new Date(s.last_seen_at).getTime() > 3600_000) {
      refreshed = true;
      await this.db.query("update sessions set last_seen_at = now(), expires_at = $2 where id_hash = $1", [
        idHash,
        new Date(Date.now() + slideFor(s.kind)),
      ]);
      if (person) await this.db.query("update people set last_seen_at = now() where id = $1", [person.id]);
    }
    return { kind: s.kind, person, csrf: s.csrf_token, idHash, refreshed, ...(s.kind === "owner" ? { deviceId: s.owner_device_id } : {}) };
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.db.query("delete from sessions where id_hash = $1", [idHash]);
  }

  async purgeExpiredSessions(): Promise<void> {
    await this.db.query("delete from sessions where expires_at < now()");
  }

  /**
   * Deletes owner sessions whose credential is gone: opened with another
   * bootstrap token, or with a revoked device (all of them when owner access is
   * off). Returns how many.
   */
  async purgeStaleOwnerSessions(): Promise<number> {
    const rows = await this.db.query(
      `delete from sessions s where s.kind = 'owner' and (
         $1 = ''
         or (s.owner_device_id is null and s.owner_fp is distinct from $1)
         or exists (select 1 from owner_devices d where d.id = s.owner_device_id and d.revoked_at is not null)
       ) returning id_hash`,
      [this.ownerFp],
    );
    return rows.length;
  }

  // --- owner devices and enrollment codes ---

  listDevices(): Promise<OwnerDevice[]> {
    return this.db.query<OwnerDevice>(`select ${DEVICE_COLS} from owner_devices order by revoked_at nulls first, created_at, id`);
  }

  async getDevice(id: number): Promise<OwnerDevice | null> {
    const [d] = await this.db.query<OwnerDevice>(`select ${DEVICE_COLS} from owner_devices where id = $1`, [id]);
    return d ?? null;
  }

  /**
   * The active device whose token hashes to `tokenHash`: looked up by the hash
   * (an index lookup), then compared in constant time.
   */
  async deviceByTokenHash(tokenHash: string): Promise<OwnerDevice | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    const [d] = await this.db.query<OwnerDevice & { token_hash: string }>(
      `select ${DEVICE_COLS}, token_hash from owner_devices where token_hash = $1 and revoked_at is null`,
      [tokenHash],
    );
    if (!d || !safeEqual(d.token_hash, tokenHash)) return null;
    const { token_hash: _, ...device } = d;
    return device;
  }

  /** Session fingerprint of a device's credential. */
  async deviceFingerprint(id: number): Promise<string | null> {
    const [d] = await this.db.query<{ token_hash: string }>("select token_hash from owner_devices where id = $1 and revoked_at is null", [id]);
    return d ? ownerSessionFingerprint(d.token_hash) : null;
  }

  /** Records that a device was used: at most once a minute per device. */
  async touchDevice(id: number): Promise<void> {
    const now = this.clock();
    const last = this.touched.get(id);
    if (last !== undefined && now - last < DEVICE_TOUCH_MS && now >= last) return;
    this.touched.set(id, now);
    if (this.touched.size > 1000) this.touched.clear();
    await this.db.query("update owner_devices set last_used_at = $2 where id = $1 and (last_used_at is null or last_used_at < $3)", [
      id,
      new Date(now),
      new Date(now - DEVICE_TOUCH_MS),
    ]);
  }

  /** Revokes a device and ends the sessions opened with it. Null if there's no such device. */
  async revokeDevice(id: number): Promise<{ device: OwnerDevice; sessions: number } | null> {
    return this.db.tx(async (q) => {
      await q.query("update owner_devices set revoked_at = $2 where id = $1 and revoked_at is null", [id, new Date(this.clock())]);
      const [device] = await q.query<OwnerDevice>(`select ${DEVICE_COLS} from owner_devices where id = $1`, [id]);
      if (!device) return null;
      const sessions = await q.query("delete from sessions where owner_device_id = $1 returning id_hash", [id]);
      return { device, sessions: sessions.length };
    });
  }

  /** Enrollment codes that can still be used. */
  async activeEnrollCodes(maxAttempts: number): Promise<number> {
    const [r] = await this.db.query<{ n: number }>(
      "select count(*)::int as n from enroll_codes where used_at is null and expires_at > $1 and attempts < $2",
      [new Date(this.clock()), maxAttempts],
    );
    return r?.n ?? 0;
  }

  /** Stores a new enrollment code (its hash) for a device to be called `deviceName`. */
  async createEnrollCode(codeHash: string, deviceName: string, createdBy: string, ttlMs: number): Promise<Date> {
    const now = this.clock();
    const expires = new Date(now + ttlMs);
    await this.db.query(
      "insert into enroll_codes (code_hash, device_name, created_by_device, created_at, expires_at) values ($1, $2, $3, $4, $5)",
      [codeHash, deviceName, createdBy, new Date(now), expires],
    );
    return expires;
  }

  /**
   * Uses an enrollment code (by its hash): if it is unused, unexpired and has
   * attempts left, it is spent and a device is created (named `name`, or as the
   * code says); its token is returned, the only time it exists in clear. A
   * wrong code counts as a failed attempt against every active code (which
   * one it was meant for can't be known), so each code survives at most
   * `maxAttempts` guesses in total.
   */
  async redeemEnrollCode(
    codeHash: string,
    name: string | null,
    maxAttempts: number,
  ): Promise<{ device: OwnerDevice; token: string; createdBy: string } | null> {
    const now = new Date(this.clock());
    return this.db.tx(async (q) => {
      const [c] = await q.query<{ device_name: string; created_by_device: string }>(
        `update enroll_codes set used_at = $2 where code_hash = $1 and used_at is null and expires_at > $2 and attempts < $3
         returning device_name, created_by_device`,
        [codeHash, now, maxAttempts],
      );
      if (!c) {
        await q.query("update enroll_codes set attempts = attempts + 1 where used_at is null and expires_at > $1 and attempts < $2", [now, maxAttempts]);
        return null;
      }
      const token = newOwnerToken();
      const [device] = await q.query<OwnerDevice>(
        `insert into owner_devices (name, token_hash, created_at, created_from) values ($1, $2, $3, $4) returning ${DEVICE_COLS}`,
        [name || c.device_name, sha256Hex(token), now, c.created_by_device],
      );
      return { device: device!, token, createdBy: c.created_by_device };
    });
  }

  /** Forgets enrollment codes that expired more than a day ago. */
  async purgeEnrollCodes(): Promise<void> {
    await this.db.query("delete from enroll_codes where expires_at < $1", [new Date(this.clock() - 24 * 3600_000)]);
  }

  /** "Close all sessions": every owner web session and, optionally, every reviewer session. */
  async closeAllSessions(reviewersToo: boolean): Promise<{ owner: number; reviewers: number }> {
    const owner = await this.db.query("delete from sessions where kind = 'owner' returning id_hash");
    const reviewers = reviewersToo ? await this.db.query("delete from sessions where kind = 'reviewer' returning id_hash") : [];
    return { owner: owner.length, reviewers: reviewers.length };
  }

  // --- versions ---

  async createVersion(
    doc: Document,
    input: {
      title: string;
      note: string;
      pdfKey: string;
      pdfSha256: string;
      pdfSize: number;
      pages: string[];
      progress: Progress | null;
      sectionPages: SectionPages[];
    },
  ): Promise<Version> {
    return this.db.tx(async (q) => {
      // One publication at a time per document: the number is max + 1.
      await q.query("select id from documents where id = $1 for update", [doc.id]);
      const [{ n } = { n: 1 }] = await q.query<{ n: number }>(
        "select coalesce(max(number), 0) + 1 as n from versions where document_id = $1",
        [doc.id],
      );
      const [v] = await q.query<Version>(
        `insert into versions (document_id, number, title, note, pdf_key, pdf_sha256, pdf_size, page_count, progress, section_pages)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) returning *`,
        [
          doc.id,
          n,
          input.title,
          input.note,
          input.pdfKey,
          input.pdfSha256,
          input.pdfSize,
          input.pages.length,
          input.progress === null ? null : JSON.stringify(input.progress),
          JSON.stringify(input.sectionPages),
        ],
      );
      for (let i = 0; i < input.pages.length; i += 100) {
        const chunk = input.pages.slice(i, i + 100);
        const values = chunk.map((_, j) => `($1, $${2 * j + 2}, $${2 * j + 3})`).join(", ");
        await q.query(`insert into version_pages (version_id, page, text) values ${values}`, [v!.id, ...chunk.flatMap((t, j) => [i + j + 1, t])]);
      }
      return v!;
    });
  }

  listVersions(documentId: number): Promise<Version[]> {
    return this.db.query<Version>("select * from versions where document_id = $1 order by number desc", [documentId]);
  }

  async getVersion(documentId: number, number: number): Promise<Version | null> {
    const [v] = await this.db.query<Version>("select * from versions where document_id = $1 and number = $2", [documentId, number]);
    return v ?? null;
  }

  async latestVersion(documentId: number): Promise<Version | null> {
    const [v] = await this.db.query<Version>("select * from versions where document_id = $1 order by number desc limit 1", [documentId]);
    return v ?? null;
  }

  async previousVersion(v: Version): Promise<Version | null> {
    const [p] = await this.db.query<Version>(
      "select * from versions where document_id = $1 and number < $2 order by number desc limit 1",
      [v.document_id, v.number],
    );
    return p ?? null;
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
    const rows = await this.db.query<{ text: string }>("select text from version_pages where version_id = $1 order by page", [versionId]);
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
        `insert into threads (document_id, version_id, page, anchor, quote, rects, author_kind, person_id)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) returning id`,
        [version.document_id, version.id, input.page, input.anchor, input.quote, JSON.stringify(input.rects), viewer.kind, viewer.personId],
      );
      await q.query("insert into comments (thread_id, author_kind, person_id, body) values ($1, $2, $3, $4)", [
        t!.id,
        viewer.kind,
        viewer.personId,
        input.body,
      ]);
      return t!.id;
    });
  }

  async addReply(threadId: number, body: string, viewer: Viewer): Promise<number> {
    return this.db.tx(async (q) => {
      const [c] = await q.query<{ id: number }>(
        "insert into comments (thread_id, author_kind, person_id, body) values ($1, $2, $3, $4) returning id",
        [threadId, viewer.kind, viewer.personId, body],
      );
      await q.query("update threads set updated_at = now() where id = $1", [threadId]);
      return c!.id;
    });
  }

  /** Comments (thread openings included) a person wrote since `since`, in any document. */
  async countPersonComments(personId: number, since: Date): Promise<number> {
    const [r] = await this.db.query<{ n: number }>(
      "select count(*)::int as n from comments where person_id = $1 and created_at >= $2",
      [personId, since],
    );
    return r?.n ?? 0;
  }

  /** The document a thread belongs to. */
  async threadDocument(threadId: number): Promise<Document | null> {
    const [d] = await this.db.query<Document>(
      `select ${prefixed(DOC_COLS, "d")} from threads t join documents d on d.id = t.document_id where t.id = $1`,
      [threadId],
    );
    return d ?? null;
  }

  async getComment(id: number): Promise<{ id: number; thread_id: number; author_kind: AuthorKind; person_id: number | null; deleted_at: Date | null } | null> {
    const [c] = await this.db.query<{ id: number; thread_id: number; author_kind: AuthorKind; person_id: number | null; deleted_at: Date | null }>(
      "select id, thread_id, author_kind, person_id, deleted_at from comments where id = $1",
      [id],
    );
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

  async setStatus(threadId: number, status: "open" | "resolved", by: Viewer): Promise<void> {
    const resolved = status === "resolved";
    await this.db.query(
      `update threads set status = $2, resolved_at = ${resolved ? "now()" : "null"},
       resolved_by_kind = $3, resolved_by_person_id = $4, updated_at = now() where id = $1`,
      resolved ? [threadId, status, by.kind, by.personId] : [threadId, status, null, null],
    );
  }

  /** Threads of a document visible to `viewer`, with their comments. */
  async listThreads(
    doc: Document,
    viewer: Viewer,
    filter: { versionNumber?: number; status?: "open" | "resolved"; threadId?: number; since?: Date } = {},
  ): Promise<ThreadOut[]> {
    const params: unknown[] = [doc.id];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ["t.document_id = $1"];
    if (filter.versionNumber !== undefined) where.push(`v.number = ${p(filter.versionNumber)}`);
    if (filter.status) where.push(`t.status = ${p(filter.status)}`);
    if (filter.threadId !== undefined) where.push(`t.id = ${p(filter.threadId)}`);
    // "own": a reviewer sees the threads opened by the owner or by them, and in
    // them only the owner's comments and their own.
    const own = viewer.kind === "reviewer" && doc.visibility === "own";
    if (own) where.push(`(t.author_kind = 'owner' or t.person_id = ${p(viewer.personId)})`);
    const threads = await this.db.query<{
      id: number;
      number: number;
      page: number;
      anchor: "text" | "point";
      quote: string;
      rects: Rect[];
      status: "open" | "resolved";
      resolved_at: Date | null;
      resolved_by_kind: AuthorKind | null;
      resolved_by_person_id: number | null;
      author_kind: AuthorKind;
      person_id: number | null;
      created_at: Date;
      updated_at: Date;
      section_pages: SectionPages[];
    }>(
      `select t.*, v.number, v.section_pages from threads t join versions v on v.id = t.version_id
       where ${where.join(" and ")} order by v.number desc, t.page, t.id`,
      params,
    );
    if (threads.length === 0) return [];
    const comments = await this.db.query<{
      id: number;
      thread_id: number;
      author_kind: AuthorKind;
      person_id: number | null;
      body: string;
      created_at: Date;
      edited_at: Date | null;
      deleted_at: Date | null;
    }>(
      `select * from comments where thread_id = any($1::int[])
       ${own ? "and (author_kind = 'owner' or person_id = $2)" : ""} order by created_at, id`,
      own ? [threads.map((t) => t.id), viewer.personId] : [threads.map((t) => t.id)],
    );
    const ids = new Set<number>();
    for (const t of threads) {
      if (t.person_id !== null) ids.add(t.person_id);
      if (t.resolved_by_person_id !== null) ids.add(t.resolved_by_person_id);
    }
    for (const c of comments) if (c.person_id !== null) ids.add(c.person_id);
    const people = ids.size
      ? await this.db.query<{ id: number; name: string; role: string | null }>(
          `select p.id, p.name, i.role from people p left join invitations i on i.person_id = p.id and i.document_id = $2
           where p.id = any($1::int[])`,
          [[...ids], doc.id],
        )
      : [];
    const byId = new Map(people.map((x) => [x.id, x]));
    const author = (kind: AuthorKind, id: number | null): Author =>
      kind === "owner"
        ? { kind, person_id: null, name: this.ownerName, role: "" }
        : { kind, person_id: id, name: byId.get(id ?? -1)?.name ?? "?", role: byId.get(id ?? -1)?.role ?? "" };
    const byThread = new Map<number, CommentOut[]>();
    for (const c of comments) {
      const list = byThread.get(c.thread_id) ?? [];
      const deleted = c.deleted_at !== null;
      list.push({
        id: c.id,
        author: author(c.author_kind, c.person_id),
        body: deleted ? null : c.body,
        body_html: deleted ? "" : renderComment(c.body),
        created_at: iso(c.created_at)!,
        edited_at: iso(c.edited_at),
        deleted,
        mine: c.author_kind === viewer.kind && (viewer.kind === "owner" || c.person_id === viewer.personId),
      });
      byThread.set(c.thread_id, list);
    }
    const since = filter.since?.getTime();
    const resolvedBy = (t: (typeof threads)[number]): string | null => {
      if (t.resolved_by_kind === null) return null;
      if (t.resolved_by_kind === "owner") return this.ownerName;
      // With "own", another reviewer's name stays hidden.
      if (own && t.resolved_by_person_id !== viewer.personId) return null;
      return byId.get(t.resolved_by_person_id ?? -1)?.name ?? null;
    };
    return threads
      .map((t): ThreadOut => {
        const ch = sectionOfPage(t.section_pages ?? [], t.page);
        return {
          id: t.id,
          document: doc.slug,
          version: t.number,
          page: t.page,
          anchor: t.anchor,
          quote: t.quote,
          rects: t.rects,
          status: t.status,
          resolved_at: iso(t.resolved_at),
          resolved_by: t.status === "resolved" ? resolvedBy(t) : null,
          section: ch ? { id: ch.id, title: ch.title } : null,
          author: author(t.author_kind, t.person_id),
          created_at: iso(t.created_at)!,
          updated_at: iso(t.updated_at)!,
          can_resolve: viewer.kind === "owner" || (t.author_kind === "reviewer" && t.person_id === viewer.personId),
          comments: byThread.get(t.id) ?? [],
        };
      })
      .filter((t) => since === undefined || t.comments.some((c) => Date.parse(c.created_at) >= since));
  }

  /**
   * What a reviewer hasn't heard about in a document: comments by others since
   * `since`, in the threads they opened or replied to, as that reviewer sees
   * them (the document's visibility included).
   */
  async reviewerUpdates(doc: Document, personId: number, since: Date): Promise<{ thread: ThreadOut; comment: CommentOut }[]> {
    const threads = await this.listThreads(doc, { kind: "reviewer", personId }, { since });
    return threads.flatMap((t) =>
      participates(t, personId)
        ? t.comments
            .filter((c) => !c.deleted && !isBy(c, personId) && Date.parse(c.created_at) >= since.getTime())
            .map((comment) => ({ thread: t, comment }))
        : [],
    );
  }

  // --- digest bookkeeping (a day is marked only after its digest went out) ---

  async digestDone(documentId: number, day: string): Promise<boolean> {
    return (await this.db.query("select 1 from digest_runs where document_id = $1 and day = $2", [documentId, day])).length > 0;
  }

  async markDigest(documentId: number, day: string): Promise<void> {
    await this.db.query("insert into digest_runs (document_id, day) values ($1, $2) on conflict do nothing", [documentId, day]);
  }

  async reviewerDigestDone(invitationId: number, day: string): Promise<boolean> {
    return (await this.db.query("select 1 from reviewer_digest_runs where invitation_id = $1 and day = $2", [invitationId, day])).length > 0;
  }

  async markReviewerDigest(invitationId: number, day: string): Promise<void> {
    await this.db.query("insert into reviewer_digest_runs (invitation_id, day) values ($1, $2) on conflict do nothing", [invitationId, day]);
  }

  /** When the invitation's last digest went out. */
  async lastReviewerDigest(invitationId: number): Promise<Date | null> {
    const [r] = await this.db.query<{ at: Date | null }>("select max(sent_at) as at from reviewer_digest_runs where invitation_id = $1", [invitationId]);
    return r?.at ? new Date(r.at) : null;
  }
}

async function grant(q: Queryable, idHash: string, invitationId: number): Promise<void> {
  await q.query("insert into session_invitations (session_id_hash, invitation_id) values ($1, $2) on conflict do nothing", [idHash, invitationId]);
  await q.query("update invitations set last_seen_at = now() where id = $1", [invitationId]);
  await q.query("update people set last_seen_at = now() where id = (select person_id from invitations where id = $1)", [invitationId]);
}

const isBy = (c: { author: { kind: AuthorKind; person_id: number | null } }, personId: number) =>
  c.author.kind === "reviewer" && c.author.person_id === personId;

/** A reviewer takes part in a thread they opened or replied to. */
export function participates(t: ThreadOut, personId: number): boolean {
  return isBy(t, personId) || t.comments.some((c) => isBy(c, personId));
}

export type { Queryable };
