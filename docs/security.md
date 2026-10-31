# Security

doc-review holds unpublished documents and frank comments about them. This page
describes what it protects, against whom, and how.

## Assets

- The PDFs of every version (and their extracted text).
- The comments, their authors and their history.
- The owner tokens (the main one and each device's: any of them can do
  everything), one-time enrollment codes, reviewers' personal links, sessions.
- Notification credentials: the Telegram bot token, the SMTP password, S3 keys,
  database DSNs.

## Actors and threats

| Actor | Could try to | Measures |
|---|---|---|
| Anyone on the internet | Read documents, guess links, brute-force the owner token, probe the API | Authentication everywhere; 256-bit secrets; rate limits; 404 for anything not accessible; no indexing |
| A reviewer | Read documents they aren't invited to; read other reviewers' comments when the document is in «own» mode; resolve or edit others' threads; flood the server | Per-document access checks; visibility applied in SQL and in notifications; ownership checks; per-person rate limits and a daily cap |
| Someone with a leaked link | Act as that reviewer | Revocation and rotation (sessions opened with the link end); a browser with another session asks before switching |
| A malicious web page | CSRF, clickjacking, reading responses | SameSite cookies, origin check and CSRF tokens, `frame-ancestors 'none'`, CORP/COOP |
| Untrusted text (comments, names, titles) | XSS in the browser; terminal escape sequences in the CLI; markup or links in Emacs; formatting in Telegram/email; bidi tricks | Escaping, a tiny markup subset, control/bidi stripping on input and output, org fixed-width lines in Emacs, plain-text notifications |
| A hostile PDF | Exhaust memory or CPU; exploit the parser | Size limit, magic bytes, parsing in a worker thread with a 512 MB heap and a 90 s timeout; the browser renders it with pdf.js under a strict CSP |
| A malicious repository (`.doc-review.json`) | Send your owner token to another server | The project file only selects a server; its token must be configured for that origin in your private config file; https only |
| A stolen laptop or browser | Use the owner's token or web session | Each computer has its own device token: revoking it refuses the token and ends its sessions at once; «Close all sessions»; rotating the main token ends every web session opened with it |
| Someone who sees or guesses an enrollment code | Link their own computer as an owner device | Codes live 10 minutes, work once, die after 5 wrong attempts in total; 50 bits; rate limits per IP and global; the device shows up on the Devices page |
| A malicious web page | Make a visitor's browser redeem a code | The enrollment endpoint uses no cookies and refuses any `Origin` or `Sec-Fetch-Site` that isn't the site itself |
| The logs | Leak secrets | Link paths are redacted, tokens and credentials are never logged, Telegram errors omit the URL |

Out of scope: a compromised server or cluster (it holds everything), a
compromised owner machine while it is compromised (it holds a token; revoke
that device), and denial of service beyond what the rate limits and the
single-replica design absorb.

## Links and sessions

**One link per invitation** (a person × a document), so the owner can revoke or
rotate one document's access without touching the person's other documents.

**One session per person.** Opening any of a person's links signs them in and
shows all their documents: a reviewer with three documents doesn't need three
links in the same browser. The session remembers which links it was opened
with (`session_invitations`):

- Access to a document is checked on every request against the person's
  *active* invitations: revoking an invitation removes that document from every
  session at once.
- **Rotating** a link (the response to a leak) deletes every session that was
  opened with it — including an intruder's — and the old link stops working.
- **Revoking** a link also ends the sessions opened only with revoked links; a
  session that was also opened with another active link of the same person keeps
  that person's other documents.
- Opening another link of the same person in a browser that has their session
  adds it to the session; a link of *someone else* asks first («Sign in as …?»,
  a POST with the CSRF token of the current session).

The trade-off: until the owner rotates or revokes it, a leaked link gives access
to all of that person's documents, not just the one it was made for. The
alternative (a session per link) would make a reviewer of several documents keep
and open several links per browser; rotation is immediate and cheap, so this is
the better balance for a small group of known reviewers.

Link secrets are 32 random bytes (base64url) stored as SHA-256; the lookup is
by hash. `/a/<secret>` creates the session and redirects (303) to the document,
so the secret doesn't stay in the address bar or history. The path is never
URL-decoded (anything but 43 base64url characters is a 404) and never logged.
Link pages are `Referrer-Policy: no-referrer`.

Sessions: random 32-byte ids stored hashed; cookie `__Host-dr_session`,
`HttpOnly; Secure; SameSite=Lax`; 30 days for the owner, 180 days for
reviewers, sliding (the cookie's `Max-Age` is renewed with the server-side
expiry, at most once an hour).

## The owner

- The CLI and Emacs send `Authorization: Bearer <token>`; such requests read no
  cookies, so CSRF doesn't apply. On the web the token is entered once at
  `/login` (a pre-session double-submit cookie protects the form) and becomes a
  session.
- The server only knows `OWNER_TOKEN_SHA256` and the hashes of device tokens;
  comparisons are timing-safe.
- Owner sessions store a fingerprint of the credential they were opened with:
  rotating the main token ends its sessions (also at startup), revoking a device
  ends that device's (see [below](#owner-devices-and-enrollment-codes)).
  «Close all sessions» (dashboard, `POST /api/sessions/close-all`,
  `doc-review sessions close-all [--reviewers]`) ends every owner web session
  and, optionally, every reviewer session.
- Clients refuse `http://` except for localhost, and send the token only to the
  server it was configured for (`config.json` mode 0600 is enforced).

## Owner devices and enrollment codes

The main («bootstrap») owner token is the one whose SHA-256 is
`OWNER_TOKEN_SHA256`. Besides it, each computer can have a **device token** of
its own (`dr_owner_` + 32 random bytes), stored as SHA-256 in `owner_devices`.

- **Same powers.** A device token is a full owner credential: it publishes,
  invites, makes enrollment codes and revokes other devices. Devices are a way
  to *not spread* one long-lived secret and to cut one computer off without
  touching the others, not a permission system.
- **Lookup.** The bearer header and the web login accept the main token
  (timing-safe compare of hashes) or an active device token (looked up by its
  SHA-256, then compared in constant time). With `OWNER_TOKEN_SHA256` unset,
  owner access is off for device tokens too.
- **Sessions.** An owner web session stores the device it was opened with and
  a fingerprint of that credential's hash; it is valid only while the
  credential is: revoking a device deletes its sessions, rotating the main token
  ends the main token's sessions (also at startup) and leaves device sessions
  alone.
- **Revocation** is immediate and can't be undone; the main token can't be
  revoked from the API or the page (it would lock you out): rotate it in the
  Secret ([deploy.md](deploy.md#rotating-the-main-owner-token)).
- `last_used_at` is written at most once a minute per device, so you can spot
  a device that is used when it shouldn't be.

**Enrollment codes** let a new computer get a device token without the main
token ever being copied, pasted in a chat or typed on that computer:

- Made only by an owner (`POST /api/devices/enroll-codes`, the Devices page,
  `doc-review devices code`); at most 5 unused at a time.
- 10 characters of Crockford base32 (`K7Q2X-9XMPA`): 50 bits from the system's
  CSPRNG, no ambiguous letters, typed case- and hyphen-insensitively.
- Stored as SHA-256 only; a plain hash is enough because a code lives 10
  minutes (an offline search of 2^50 hashes outlasts it), and a database
  dump can't reveal used or expired codes.
- Redeemed at the **public** `POST /api/devices/enroll`, which reads no cookie
  and sets none (so CSRF doesn't apply); a request carrying an `Origin` other
  than `PUBLIC_URL` (including `null`) or a `Sec-Fetch-Site` other than
  `same-origin` is refused, so a page elsewhere can't drive a visitor's browser
  to it. The CLI, Emacs and curl send neither header.
- **Single use**: spending a code and creating the device happen in one
  transaction (`update … where used_at is null … returning`), so two racing
  requests can't both win. The token is in the response once and nowhere else.
- **Guessing**: the server can't tell which code a wrong guess was meant for,
  so every wrong (or malformed) attempt counts against *every* active code,
  and a code is dead after 5. Together with 10 attempts per IP (per /64 for
  IPv6) and 30 in total per 10 minutes, an attacker gets at most 5 guesses per
  code: a chance of about 5 in 10^15. The price is that a stranger hammering the
  endpoint can kill your active codes; you then make a new one.
- Malformed codes go through the same hash lookup and update as wrong ones.
- The logs say when a code was made and by which device, and when a device was
  enrolled, failed to enroll (with the client IP) or was revoked — never a code
  or a token.

## Requests

- **CSRF** for cookie-authenticated mutations: the same origin (`Origin` equal
  to `PUBLIC_URL`; when a browser sends `Origin: null` or none,
  `Sec-Fetch-Site: same-origin`) **and** the session's CSRF token
  (`X-CSRF-Token` or the `_csrf` form field).
- **Headers**: CSP `default-src 'none'; script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src
  'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none';
  frame-ancestors 'none'` (no inline scripts or styles; the pages' messages are a
  non-executable JSON block), `X-Frame-Options: DENY`, `nosniff`, COOP/CORP
  same-origin, `Permissions-Policy`, HSTS on https, `Referrer-Policy:
  same-origin`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store` for
  pages and API.
- **Validation**: JSON bodies ≤ 64 KB; comments ≤ 10 000 characters, quotes ≤
  2 000, names and titles one line; ≤ 50 rectangles with coordinates in [0, 1];
  versions, pages and ids are integers in range; slugs, languages, visibility
  and notification settings from fixed sets. Invalid input is a 400 with a
  translated message, never a database error or a stack trace in the logs.
- **Rate limits** (per IP, IPv6 per /64, from `CF-Connecting-IP` behind
  Cloudflare): links 20/10 min, owner login 10/10 min, failed bearer tokens 30/10
  min, device enrollment 10/10 min (and 30/10 min for everyone); writes 60/min per person; at most `MAX_REVIEWER_COMMENTS_PER_DAY` threads
  and replies per reviewer in 24 hours over all documents. At most 10 000 keys in
  memory.

## Access and visibility

- A reviewer gets 404 (not 403) for documents, versions, PDFs and threads of
  documents they aren't invited to, so existence doesn't leak.
- With visibility «own», a reviewer sees only the threads opened by the owner or
  by them, and in them only the owner's comments and their own; who resolved a
  thread is hidden if it was another reviewer; the open-thread counts they see
  follow the same rule, and they never see how many other reviewers there are.
  Reply notifications are computed as each reviewer sees the thread: a comment
  they can't see never notifies them.
- Only the reviewer who opened a thread, or the owner, can resolve it; anyone who
  sees it can reopen it. Only the author of a comment can edit or delete it
  (deletes are soft; the owner can read the last 20 previous texts of an edited
  comment).
- Archived documents are read-only for everyone.

## Untrusted text

- All HTML is built with escaping; comment bodies are escaped and then get a tiny
  markup subset (`**bold**`, `*italic*`, `` `code` ``, http(s) links with
  `rel=noopener noreferrer nofollow`). The browser inserts only that
  server-rendered HTML; everything else is set with `textContent`.
- C0/C1 control characters (except tab and newline) and bidi controls
  (U+202A–202E, U+2066–2069, ALM/LRM/RLM) are removed on input, and again on
  output in the CLI, Emacs (buffers, Flymake, prompts) and Telegram/email.
- Emacs shows untrusted text as org fixed-width lines (`: …`), so it can't become
  a link or markup; headings are cleaned of link brackets.
- Telegram messages are plain text (no parse mode, no link previews).

## Uploads and storage

- PDF ≤ `MAX_PDF_MB` (50), `%PDF-` at the start, and pdf.js must open every page
  (≤ 2 000) before the version is accepted. Parsing runs in a worker thread with a
  512 MB heap limit and a 90 s timeout. `progress.json` ≤ 1 MB, validated field
  by field.
- PDFs are stored by SHA-256 (`pdf/<sha>.pdf`, keys validated); served only to
  whoever may see the document, `Cache-Control: private`.

## Notifications

- Emails to reviewers never include their personal link, except the one the owner
  explicitly sends («Send the link by email» when inviting, or «Email a new
  link», which asks for confirmation and names the address). Since only a hash
  of each link is stored, emailing a link always means a new one; the request is
  refused before anything changes if the person has no address or SMTP is off,
  so a working link is never invalidated for an email that can't go out.
- Deleting a person is only possible if they never wrote a comment; otherwise
  they are archived: every invitation revoked and every session ended at once.
- Messages link to the thread on the public URL; they carry excerpts, never
  secrets.
- Failures are logged without credentials and never fail a request; digests are
  marked as sent only once they went out.

## Deployment

- Non-root (uid 10001), read-only root file system, all capabilities dropped,
  seccomp `RuntimeDefault`, no service account token: PodSecurity `restricted`.
- Migrations run in a hook Job with the admin DSN, which the app pod never sees;
  the app role can't alter tables.
- An optional NetworkPolicy lets only cloudflared in and only DNS, Postgres and
  HTTPS/SMTP out.
- Secrets come only from the environment (a SOPS-encrypted Secret in gitops) and
  are never logged; the startup line says which channels are on, not their
  values.
