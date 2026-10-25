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
create table directors (
  id serial primary key,
  name text not null,
  role text not null default '',
  email text,
  notify_versions boolean not null default false,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

create table sessions (
  id_hash text primary key,
  kind text not null check (kind in ('owner', 'director')),
  director_id integer references directors(id),
  csrf_token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index sessions_director_idx on sessions (director_id);

create table versions (
  id serial primary key,
  number integer not null unique,
  title text not null,
  note text not null default '',
  pdf_key text not null,
  pdf_sha256 text not null,
  pdf_size integer not null,
  page_count integer not null,
  progress jsonb,
  section_pages jsonb not null,
  created_at timestamptz not null default now()
);

create table version_pages (
  version_id integer not null references versions(id) on delete cascade,
  page integer not null,
  text text not null,
  primary key (version_id, page)
);

create table threads (
  id serial primary key,
  version_id integer not null references versions(id),
  page integer not null,
  anchor text not null check (anchor in ('text', 'point')),
  quote text not null default '',
  rects jsonb not null,
  author_kind text not null check (author_kind in ('owner', 'director')),
  director_id integer references directors(id),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_version_idx on threads (version_id);

create table comments (
  id serial primary key,
  thread_id integer not null references threads(id),
  author_kind text not null check (author_kind in ('owner', 'director')),
  director_id integer references directors(id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index comments_thread_idx on comments (thread_id);
create index comments_created_idx on comments (created_at);

create table settings (
  key text primary key,
  value jsonb not null
);

create table digest_runs (
  day date primary key,
  sent_at timestamptz not null default now()
);
`,
  },
  {
    // Who resolved a thread, as ids: the visibility setting can then hide the
    // name of another director, and resolve permissions can be checked.
    name: "002_resolved_by",
    sql: `
alter table threads add column resolved_by_kind text check (resolved_by_kind in ('owner', 'director'));
alter table threads add column resolved_by_director_id integer references directors(id);
`,
  },
  {
    // Owner web sessions remember which owner token they were opened with: when
    // OWNER_TOKEN_SHA256 changes (the token was rotated), they stop working.
    name: "003_owner_session_fingerprint",
    sql: `
alter table sessions add column owner_fp text;
`,
  },
  {
    name: "004_comments_by_director",
    sql: `
create index comments_director_created_idx on comments (director_id, created_at);
`,
  },
  {
    // Reply notifications for directors (opt-in), their daily digests, and the
    // previous texts of edited comments.
    name: "005_director_notifications_and_edits",
    sql: `
alter table directors add column notify_replies text not null default 'never' check (notify_replies in ('instant', 'daily', 'never'));

create table director_digest_runs (
  director_id integer not null references directors(id),
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (director_id, day)
);

create table comment_edits (
  id serial primary key,
  comment_id integer not null references comments(id),
  body text not null,
  edited_at timestamptz not null default now()
);
create index comment_edits_comment_idx on comment_edits (comment_id, id);
`,
  },
  {
    // The diff of each version against the previous one, computed once.
    name: "006_version_diffs",
    sql: `
create table version_diffs (
  version_id integer primary key references versions(id) on delete cascade,
  diff jsonb,
  created_at timestamptz not null default now()
);
`,
  },
];
