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
  avance jsonb not null,
  chapter_pages jsonb not null,
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
];
