// Schema migrations, applied in order and recorded in schema_migrations.
// Never edit a migration that has shipped; add a new one.

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "001_initial",
    sql: `
-- A document under review (a thesis, a paper, a report). Its versions, its
-- reviewers' invitations and its threads belong to it.
create table documents (
  id serial primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  title text not null,
  language text not null default 'en' check (language in ('en', 'es')),
  -- 'own': a reviewer sees only the owner's threads and comments and their own.
  visibility text not null default 'all' check (visibility in ('all', 'own')),
  -- Role label suggested when inviting someone (free text: "Director", "Client"…).
  default_role text not null default '',
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

-- Someone who reviews one or more documents. Notification preferences are the
-- person's; what they are notified about is decided per document (visibility).
create table people (
  id serial primary key,
  name text not null,
  email text,
  notify_versions boolean not null default false,
  notify_replies text not null default 'never' check (notify_replies in ('instant', 'daily', 'never')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- A person's access to a document, with its own secret link (stored hashed).
create table invitations (
  id serial primary key,
  document_id integer not null references documents(id),
  person_id integer not null references people(id),
  role text not null default '',
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  unique (document_id, person_id)
);
create index invitations_person_idx on invitations (person_id);

create table sessions (
  id_hash text primary key,
  kind text not null check (kind in ('owner', 'reviewer')),
  person_id integer references people(id),
  csrf_token text not null,
  -- Owner sessions: fingerprint of the owner token they were opened with.
  owner_fp text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  check ((kind = 'owner') = (person_id is null))
);
create index sessions_person_idx on sessions (person_id);

-- The invitation links a reviewer session was opened with. Rotating a link ends
-- the sessions that hold it; a session needs at least one active invitation.
create table session_invitations (
  session_id_hash text not null references sessions(id_hash) on delete cascade,
  invitation_id integer not null references invitations(id),
  primary key (session_id_hash, invitation_id)
);
create index session_invitations_invitation_idx on session_invitations (invitation_id);

create table versions (
  id serial primary key,
  document_id integer not null references documents(id),
  number integer not null,
  title text not null,
  note text not null default '',
  pdf_key text not null,
  pdf_sha256 text not null,
  pdf_size integer not null,
  page_count integer not null,
  progress jsonb,
  section_pages jsonb not null,
  created_at timestamptz not null default now(),
  unique (document_id, number)
);

create table version_pages (
  version_id integer not null references versions(id) on delete cascade,
  page integer not null,
  text text not null,
  primary key (version_id, page)
);

-- The diff of each version against the previous one, computed once.
create table version_diffs (
  version_id integer primary key references versions(id) on delete cascade,
  diff jsonb,
  created_at timestamptz not null default now()
);

create table threads (
  id serial primary key,
  document_id integer not null references documents(id),
  version_id integer not null references versions(id),
  page integer not null,
  anchor text not null check (anchor in ('text', 'point')),
  quote text not null default '',
  rects jsonb not null,
  author_kind text not null check (author_kind in ('owner', 'reviewer')),
  person_id integer references people(id),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by_kind text check (resolved_by_kind in ('owner', 'reviewer')),
  resolved_by_person_id integer references people(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_document_idx on threads (document_id, status);
create index threads_version_idx on threads (version_id);

create table comments (
  id serial primary key,
  thread_id integer not null references threads(id),
  author_kind text not null check (author_kind in ('owner', 'reviewer')),
  person_id integer references people(id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index comments_thread_idx on comments (thread_id);
create index comments_created_idx on comments (created_at);
create index comments_person_created_idx on comments (person_id, created_at);

-- Previous texts of edited comments (the last 20 of each).
create table comment_edits (
  id serial primary key,
  comment_id integer not null references comments(id),
  body text not null,
  edited_at timestamptz not null default now()
);
create index comment_edits_comment_idx on comment_edits (comment_id, id);

-- Daily digests, marked only once they went out: the owner's per document, a
-- reviewer's per invitation (each in its document's language).
create table digest_runs (
  document_id integer not null references documents(id),
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (document_id, day)
);

create table reviewer_digest_runs (
  invitation_id integer not null references invitations(id),
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (invitation_id, day)
);
`,
  },
];
