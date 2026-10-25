# doc-review

A small web app where thesis directors comment on the compiled thesis PDF, and
the author gets the comments on the web, on Telegram, by email and in Emacs, next
to the org source.

- The author publishes each compiled PDF as a **version**, with `avance.json`
  (words per chapter, goal, status) and an optional note. The server never
  compiles LaTeX.
- Each director gets a **personal secret link**. They select text in the PDF (or
  click a spot) and comment; threads have replies, resolve (the opener or the
  owner) / reopen (anyone who sees the thread), edit and (soft) delete of one's
  own comments. Comments belong to the version they were made on.
- Each version shows the **progress per chapter** and **what changed** since the
  previous version: word deltas from `avance.json` and a sentence-level text diff
  per chapter, computed on the server from the PDF text.
- The author is notified of new comments and replies by **Telegram** and/or
  **email** (SMTP, e.g. Proton Mail), optionally as a daily digest, including
  when a director edits a comment. Directors can opt in to an email when a new
  version is published, and to emails (at once or a daily digest) when someone
  else replies in a thread they opened or replied to.
- **Emacs** (`emacs/doc-review.el`): publish from the thesis directory, read
  the comments in an org buffer with links to the matching place in the org
  sources, reply, resolve, and see open comments as Flymake notes on the text.
- A **CLI** for the same from a shell or a Makefile.

User documentation (Spanish): [docs/uso.md](docs/uso.md). Deployment:
[docs/deploy.md](docs/deploy.md).

![Director view](docs/images/03-visor-director.png)

## Architecture

```
browser (pdf.js viewer, plain ES modules)      Emacs (url.el)   CLI (fetch)
        │  session cookie + CSRF token               │ Bearer owner token
        └──────────────────────┬─────────────────────┘
                     node:http server (TypeScript)
     routes · auth · CSRF · CSP · rate limits · pages (server-rendered HTML)
        │                 │                    │                    │
   Postgres (pg)     PDF store           pdf.js (Node)        notifications
   CloudNativePG     PVC dir or S3/R2    validate + extract   Telegram, SMTP
   or PGlite (dev)   (aws4fetch)         text per page        (nodemailer)
```

| Path | What |
|---|---|
| `src/server/app.ts` | Routing, authentication, CSRF, security headers, all handlers |
| `src/server/pages.ts` | Server-rendered HTML (Spanish UI); everything escaped |
| `src/repo.ts` | All SQL |
| `src/db/` | `pg`/PGlite adapter and migrations (`schema_migrations`) |
| `src/pdf/` | PDF validation and text extraction (pdf.js legacy build) in a worker thread |
| `src/diff.ts` | Chapter location in the PDF, Myers diff over sentences |
| `src/avance.ts` | `avance.json` validation; generation from `tesis.org` includes |
| `src/notify/notify.ts` | Telegram, SMTP, digest, director emails |
| `src/storage.ts` | PDF storage: directory or S3 |
| `src/cli.ts`, `src/client.ts`, `src/format.ts` | CLI (server and owner commands) |
| `public/` | Browser code: `viewer.js` (pdf.js, selection, threads), `admin.js` |
| `emacs/` | Emacs client and its ERT tests |
| `deploy/helm/doc-review` | Helm chart |
| `deploy/infra-draft/` | Draft files for the private `infra`/`gitops` repos (not applied) |

### Data model

`directors` (name, role, optional email, `notify_versions`, `notify_replies`
instant/daily/never, `token_hash`, revoked/rotated dates) · `sessions`
(`id_hash`, kind owner/director, CSRF token, sliding expiry, owner-token
fingerprint) · `versions` (number, note, PDF key + SHA-256, page count, `avance`
JSON, located chapter pages) · `version_pages` (extracted text) ·
`version_diffs` (the stored diff against the previous version) · `threads`
(version, page, anchor `text`/`point`, quote, normalized rects, status, who
resolved it) · `comments` (thread, author, body, edited/deleted timestamps —
deletes are soft) · `comment_edits` (previous texts, the last 20) · `settings`
(`comments_visibility`) · `digest_runs`, `director_digest_runs`.

Migrations are in `src/db/migrations.ts`. In the cluster the chart runs them in
a Helm hook Job with the CloudNativePG `<app>_admin` role (owner of the tables),
whose DSN only that Job sees; the app runs with `DATABASE_URL` (the `<app>_app`
role) and `MIGRATE_ON_START=false`, and refuses to start if one is pending.
Locally they run at startup (`DATABASE_ADMIN_URL`, default `DATABASE_URL`).
`doc-review migrate` runs them by hand.

### Why these choices

- **Postgres** because the cluster already has CloudNativePG with per-app roles,
  WAL archiving and daily backups to R2 (`infra/charts/postgres-cluster`,
  `cnpg-app-database`). PGlite (Postgres compiled to WASM) runs the same SQL
  in-process, so development and tests need no database server and no network.
  `database.type: embedded` in the chart runs PGlite on the PVC if Postgres isn't
  wanted.
- **PDFs in R2** (S3) by default in the cluster, like meeting-recorder's
  recordings: off the node's disk and not in the database's WAL. A PVC also works.
- **pdf.js** both in the browser (canvas + text layer, so selections map to page
  coordinates) and on the server (upload validation, text for the diff). The
  legacy build is served to browsers because the modern one needs very recent
  JavaScript (`Map.getOrInsertComputed`).
- **Diff**: chapters are located in the PDF by their titles (skipping the table of
  contents); text is split in sentences and diffed with Myers, bounded in memory.
  If no chapter is found, the whole document is compared. Word deltas always come
  from `avance.json`.
- No frontend framework: server-rendered pages plus two small ES modules.

## Security

- **Auth on every route** except `/healthz`, `/livez`, static files, the landing
  page, the owner login form and the director link.
- **Director links**: 32 random bytes (base64url), stored as SHA-256, revocable and
  rotatable (rotation and revocation delete the director's sessions). Visiting
  `/acceso/<secret>` creates a session and redirects (303) to `/`, so the secret
  doesn't stay in history. The path is never URL-decoded (anything but 43
  base64url characters is a 404) and never logged. If the browser already has a
  session of someone else, a confirmation page asks first (switching is a POST
  with that session's CSRF token). `/acceso` pages are `Referrer-Policy:
  no-referrer`; the rest of the site is `same-origin`.
- **Owner**: `Authorization: Bearer` with the owner token (CLI, Emacs); on the
  web the token is entered once at `/entrar` and becomes a session. The server
  only knows `OWNER_TOKEN_SHA256`. Comparisons are timing-safe. Owner web
  sessions store a fingerprint of `OWNER_TOKEN_SHA256`: rotating the token ends
  them. «Cerrar todas las sesiones» (panel, `POST /api/sessions/close-all`, CLI
  `sessions close-all [--directors]`) ends every owner web session and,
  optionally, every director session.
- **Sessions**: random 32-byte ids stored hashed; cookie `__Host-dr_session`,
  `HttpOnly; Secure; SameSite=Lax`; 30 days (owner) / 180 days (directors),
  sliding (the cookie's `Max-Age` is renewed with the server-side expiry).
- **CSRF** for cookie-authenticated mutations: same origin required (`Origin`
  equal to `PUBLIC_URL`; when a browser sends `Origin: null` or none,
  `Sec-Fetch-Site: same-origin`) **and** the session's CSRF token
  (`X-CSRF-Token` header or `_csrf` field). The login form uses a pre-session
  double-submit cookie. Bearer requests read no cookies.
- **Output encoding**: all HTML is built with escaping; comment bodies are escaped
  and then get a tiny markup subset (`**bold**`, `*italic*`, `` `code` ``,
  http(s) links with `rel=noopener noreferrer nofollow`). The browser inserts only
  that server-rendered HTML; everything else is set with `textContent`. Emacs shows
  untrusted text as org fixed-width lines (`: …`), so it can't become a link or
  markup. Telegram messages are plain text.
- **Control characters**: untrusted text loses C0/C1 controls (except tab and
  newline) and bidi controls (U+202A–202E, U+2066–2069, ALM/LRM/RLM) on input,
  and again on output in the CLI, Emacs (buffers, Flymake, prompts) and
  Telegram/email, so it can't drive a terminal or read differently than it is.
- **Visibility**: with «Solo los suyos y los tuyos», a director gets only the
  threads opened by the owner or by them, and in them only the owner's comments
  and their own (also `resolved_by`, and every notification).
- **Uploads**: PDF ≤ `MAX_PDF_MB` (50), `%PDF-` magic bytes, and pdf.js must open
  every page before the version is accepted; the parsing runs in a worker thread
  with a 512 MB heap limit and a 90 s timeout. `avance.json` ≤ 1 MB, validated
  field by field. JSON bodies ≤ 64 KB; comments ≤ 10 000 characters, quotes ≤
  2 000, ≤ 50 rectangles in [0, 1]; versions, pages and ids are integers in
  range (else 400, never a database error).
- **Rate limits** (per IP — IPv6 per /64 — from `CF-Connecting-IP` behind
  Cloudflare): director links 20/10 min, owner login 10/10 min, failed bearer
  tokens 30/10 min; writes 60/min per person; at most
  `MAX_DIRECTOR_COMMENTS_PER_DAY` (500) threads + replies per director in 24 h.
  The limiter keeps at most 10 000 keys in memory.
- **Headers**: CSP `default-src 'none'; script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'
  data:; connect-src 'self'; form-action 'self'; base-uri 'none';
  frame-ancestors 'none'` (no inline scripts or styles), `X-Frame-Options: DENY`,
  `nosniff`, COOP/CORP same-origin, `Permissions-Policy`, HSTS on https,
  `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`,
  `Cache-Control: no-store` for pages and API.
- **Logs** never contain tokens, links, cookies or SMTP credentials; Telegram
  errors don't include the request URL (it holds the bot token).
- **Container**: non-root (uid 10001), read-only root file system, all
  capabilities dropped, seccomp `RuntimeDefault`, no service account token —
  fits PodSecurity `restricted`.
- Emails to directors never include their link, except when the owner explicitly
  chooses "Enviar enlace por correo" when creating or rotating it.
- **Clients**: the CLI and Emacs only talk to `https://` servers (`http://` only
  for localhost), since the owner token goes in every request.
- **Network** (chart): an optional NetworkPolicy lets only cloudflared in and only
  DNS, Postgres and HTTPS/SMTP out.

## Running locally

Requirements: Node ≥ 22.12, pnpm (corepack). No database server needed.

```sh
pnpm install
pnpm build
node dist/cli.js gen-token            # prints a token and its SHA-256
OWNER_TOKEN_SHA256=<sha256> PUBLIC_URL=http://localhost:8080 node dist/cli.js serve
# data (PGlite + PDFs) goes to ./data
```

To have the `doc-review` command on your PATH: `pnpm link --global` (or call
`node dist/cli.js`). Then put `{"url": "http://localhost:8080", "token": "<token>"}` in
`~/.config/doc-review/config.json` (`chmod 600`) and:

```sh
node test/fixtures/make-pdf.mjs /tmp/v1.pdf                 # a sample thesis PDF + avance.json
node dist/cli.js publish /tmp/v1.pdf /tmp/v1.avance.json -m "Primera versión"
node dist/cli.js directors add "Dra. Ana Torres Ruiz" --role Director
node dist/cli.js comments
```

Open `http://localhost:8080/entrar` for the owner dashboard, and the printed
`/acceso/…` link in another browser profile to act as a director.

`scripts/smoke.sh` runs the whole flow end to end against a throwaway server
(CLI, the browser API, Emacs in batch mode); with `CHROME=/path/to/chrome` it
also drives the UI with playwright-core and refreshes `docs/images/`.

### Configuration (environment)

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | Exact public origin (links, CSRF) |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `OWNER_TOKEN_SHA256` | — | Owner access is off without it |
| `OWNER_NAME` | Eduardo Ejemplo | |
| `DATABASE_URL` | `pglite:$DATA_DIR/pglite` | `postgres://…` or `pglite:<dir>`/`pglite:memory` |
| `DATABASE_ADMIN_URL` | `DATABASE_URL` | Role that runs migrations |
| `MIGRATE_ON_START` | `true` | `false`: don't migrate, refuse to start if one is pending (the chart's Job migrates) |
| `DATA_DIR` | `./data` | |
| `STORAGE_TYPE` | `fs` | `fs` (`STORAGE_DIR`, default `$DATA_DIR/files`) or `s3` |
| `S3_URL`, `S3_ENDPOINT`, `S3_REGION` | —, —, `auto` | `s3://bucket/prefix`; credentials in `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` |
| `TRUST_PROXY` | — | `cloudflare` to read `CF-Connecting-IP` |
| `MAX_PDF_MB` | `50` | |
| `MAX_DIRECTOR_COMMENTS_PER_DAY` | `500` | Threads + replies per director in 24 h; `0` = no cap |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | Telegram off unless both are set |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | —, 587, `starttls` | `starttls`, `tls` (465) or `none` (localhost relay only) |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | — | `SMTP_FROM` defaults to `SMTP_USER` |
| `EMAIL_OWNER_TO` | — | Owner address for comment emails |
| `NOTIFY_INSTANT` | `true` | `false` = digest only |
| `DIGEST_HOUR` | — | 0–23 in `TZ`; unset = no owner digest (directors' digests then go at 8:00) |
| `TZ` | `America/Mexico_City` | |

**Proton Mail**: SMTP submission works with paid plans and only for
**custom-domain addresses**. In Proton: Settings → All settings → IMAP/SMTP →
SMTP tokens → Generate token, choose the address, copy the token (shown once).
Then `SMTP_HOST=smtp.protonmail.ch`, `SMTP_PORT=587`, `SMTP_SECURITY=starttls`,
`SMTP_USER=<that address>`, `SMTP_PASSWORD=<the token>`, `SMTP_FROM=<that
address>`. The account password never works for SMTP. Proton Bridge is not
suitable for the cluster (a desktop app holding the mailbox keys).

## Tests

```sh
pnpm typecheck
pnpm test          # vitest: unit + integration (real HTTP server on an ephemeral port, PGlite in memory, temp dir)
make test-emacs    # byte-compile + ERT (HTTP mocked); or pnpm test:emacs
```

No test uses the network: notifications go to fake Telegram/SMTP transports, S3 is
tested with a fake `fetch`.

## API (owner token or session)

| Method | Path | |
|---|---|---|
| GET | `/api/me` | Who am I (+ CSRF token for sessions) |
| GET/POST | `/api/versions` | List / publish (owner; multipart `pdf`, `avance`, `note`) |
| GET | `/api/versions/:n` · `/latest` · `/:n/pdf` · `/:n/diff` | |
| GET | `/api/threads?version=N\|latest&status=open\|resolved\|all` | Threads with comments |
| POST | `/api/threads` | `{version, page, anchor: text\|point, quote, rects, body}` |
| POST | `/api/threads/:id/comments` · `/resolve` · `/reopen` | Resolve: the thread's opener or the owner (else 403) |
| PATCH/DELETE | `/api/comments/:id` | Own comments only; delete is soft |
| GET | `/api/comments/:id/edits` | Owner; previous texts of an edited comment |
| GET/POST | `/api/directors` | Owner; POST `{name, role, email, notify_versions, send_link}` returns the link once |
| PATCH | `/api/directors/:id` | Name, role, email, notify_versions, notify_replies (`instant\|daily\|never`) |
| POST | `/api/directors/:id/rotate` · `/revoke` | Rotate returns a new link (`send_link` optional) |
| GET/PUT | `/api/settings` | `comments_visibility: all\|own` |
| POST | `/api/sessions/close-all` | Owner; `{directors: true}` also closes the directors' sessions |
| GET/POST | `/notificaciones` | A director's own notification settings (HTML form) |

## Backups

Back up the **Postgres database** (CloudNativePG already archives WAL and takes
daily base backups to R2) and the **PDF store** (the R2 bucket, or the PVC when
`storage.type: pvc`; with `database.type: embedded` the PVC also holds the
database). PDFs can be re-uploaded from the thesis repository, but the comments
refer to the exact version they were made on. Secrets to keep elsewhere: the owner
token (its hash is in the cluster Secret), the bot token, the SMTP token.
