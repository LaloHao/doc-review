# Deploying doc-review

doc-review is one Node.js process with a PostgreSQL database (or the embedded
PGlite on a volume) and a place for the PDFs (a directory or an S3-compatible
bucket such as Cloudflare R2). It must run as a **single replica**: rate limits
and the digest timer live in memory.

All settings are listed in the README («Configuration»): environment variables
for the server and `values.yaml` for the Helm chart.

## 1. Owner token

```sh
docker run --rm ghcr.io/lalohao/doc-review:<tag> gen-token
```

The first line is the token (it goes in your `~/.config/doc-review/config.json`,
mode 600); the second is its SHA-256, the only thing the server stores
(`OWNER_TOKEN_SHA256`).

Other computers don't need this token: link each one as an owner *device*
with a one-time code (see [usage.md](usage.md#a-second-computer-without-the-token)).

### Rotating the main owner token

The main («bootstrap») token can't be revoked from the Devices page, because it
lives in the Secret. To replace it (it leaked, or you want to retire it):

1. `doc-review gen-token` (or the `docker run … gen-token` above) for a new
   token and its SHA-256.
2. Put the new SHA-256 in the Secret's `OWNER_TOKEN_SHA256` (for a
   SOPS-encrypted Secret in a GitOps repository: `sops secret.yaml`, change the
   key, commit) and restart the pod, which reads the Secret only at startup:
   `kubectl -n doc-review rollout restart deployment/doc-review` (use your
   namespace and release name).
3. Put the new token in `~/.config/doc-review/config.json` of the computer that
   used the old one.

At startup the server ends every web session opened with the old token; the
old token stops working at once. **Device tokens keep working**: if a device
might be compromised too, revoke it on the Devices page or with
`doc-review devices revoke ID`. Removing `OWNER_TOKEN_SHA256` altogether turns
owner access off, device tokens included.

## 2. Database

- **PostgreSQL** (recommended): create a database with two roles, an admin role
  that owns the schema (used only by `doc-review migrate`) and an app role with
  `SELECT/INSERT/UPDATE/DELETE` on the tables and `USAGE/SELECT` on the
  sequences (also as default privileges for objects the admin role creates
  later). The app gets `DATABASE_URL` (app role) only; migrations get
  `DATABASE_ADMIN_URL`.
- **Embedded** (`database.type: embedded`): PGlite on the `/data` volume; no
  database server, migrations run at startup.

## 3. PDF storage

- `storage.type: pvc` — a volume mounted at `/data` (back it up yourself), or
- `storage.type: s3` — a bucket and a token limited to it (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `storage.s3.url`, `storage.s3.endpoint`).

## 4. Secrets

Create a Secret (never created by the chart) and pass its name as
`envSecretName`:

| Key | Required | What |
|---|---|---|
| `OWNER_TOKEN_SHA256` | yes | step 1 |
| `DATABASE_URL` | postgres | app role DSN |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Telegram notifications (bot from @BotFather) |
| `SMTP_PASSWORD` | no | SMTP password or token (see «Email» below) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | s3 | unless `storage.s3.credentialsSecret` is set |

The admin DSN goes in a separate Secret, `migrations.adminSecretName`, read only
by the migration Job.

## 5. Install with Helm

```sh
helm install doc-review deploy/helm/doc-review \
  --namespace doc-review --create-namespace \
  --set publicUrl=https://review.example.com \
  --set envSecretName=doc-review-env \
  --set migrations.adminSecretName=doc-review-admin \
  --set config.ownerName="Your Name"
```

The chart has no Ingress: expose the Service through your tunnel or ingress
controller (with Cloudflare Tunnel, keep `config.trustCloudflare: true` so the
client IP comes from `CF-Connecting-IP`, and enable `networkPolicy` so only the
tunnel can reach the pod). The pods fit the `restricted` Pod Security level.

## Email

Any SMTP submission server works (`config.smtp.*` + `SMTP_PASSWORD`). For
**Proton Mail**: a paid plan and a custom-domain address are required; create an
SMTP token in Proton (Settings → IMAP/SMTP → SMTP tokens) and use
`smtp.protonmail.ch`, port 587, `starttls`, user = that address, password = the
token. Proton Bridge is meant for a desktop and doesn't suit a cluster.

## 6. First steps

```sh
curl -fsS https://review.example.com/healthz
doc-review documents create thesis "My thesis" --language es
doc-review invite -d thesis "Dr. Jane Doe" --email jane@… --role "Director"
doc-review publish -d thesis thesis.pdf progress.json -m "First draft"
```

Sign in once in the browser at `/login` with the owner token. To work from
another computer, link it from the **Devices** page instead of copying the
token.

## Backups

The database (or the `/data` volume with the embedded one) and the PDF store.
