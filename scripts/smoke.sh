#!/usr/bin/env bash
# End-to-end smoke test against a local server (no network beyond localhost):
# two documents (a Spanish thesis and an English report), a person invited to
# both with different roles, a second reviewer only on the thesis; the CLI and
# Emacs (batch) publish from a project with .doc-review.json; reviewers comment
# through the browser API (cookie + Origin + CSRF token); resolve rules and
# visibility; email notifications go to a fake SMTP server and are checked.
# With CHROME=/path/to/chrome it also drives the real UI with playwright-core
# and refreshes docs/images.
#
#   pnpm build && scripts/smoke.sh
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-8099}
SMTP_PORT=${SMTP_PORT:-2599}
BASE=http://localhost:$PORT
CLI="node $REPO/dist/cli.js"
export DOC_REVIEW_CONFIG=$WORK/config.json
MAILS=$WORK/mails.jsonl
mkdir -p "$WORK"
: > "$MAILS"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

step "owner token"
TOKEN_OUT=$($CLI gen-token)
TOKEN=$(echo "$TOKEN_OUT" | sed -n 2p | tr -d ' ')
SHA=$(echo "$TOKEN_OUT" | sed -n 4p | tr -d ' ')
printf '{"url":"%s","token":"%s"}' "$BASE" "$TOKEN" > "$DOC_REVIEW_CONFIG"
chmod 600 "$DOC_REVIEW_CONFIG"

step "fake SMTP on 127.0.0.1:$SMTP_PORT, server on $BASE (data in $WORK/data)"
node "$REPO/scripts/fake-smtp.mjs" "$SMTP_PORT" "$MAILS" &
SMTP=$!
PORT=$PORT HOST=127.0.0.1 PUBLIC_URL=$BASE DATA_DIR=$WORK/data OWNER_TOKEN_SHA256=$SHA \
  OWNER_NAME="Eduardo Ejemplo" \
  SMTP_HOST=127.0.0.1 SMTP_PORT=$SMTP_PORT SMTP_SECURITY=none SMTP_FROM=review@example.test \
  EMAIL_OWNER_TO=owner@example.test \
  node "$REPO/dist/cli.js" serve > "$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER $SMTP 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -fs "$BASE/healthz" >/dev/null && break; sleep 0.2; done

step "sample documents: a thesis project (org sources, .doc-review.json) and a report"
node "$REPO/test/fixtures/make-pdf.mjs" "$WORK/v1.pdf"
node "$REPO/test/fixtures/make-pdf.mjs" "$WORK/v2.pdf" v2
node "$REPO/test/fixtures/make-pdf.mjs" "$WORK/r1.pdf" report
node "$REPO/test/fixtures/make-pdf.mjs" "$WORK/r2.pdf" v2 report
THESIS=$WORK/tesis
mkdir -p "$THESIS/capitulos"
cat > "$THESIS/tesis.org" <<'ORG'
#+TITLE: Método computacional para la generación trazable de recomendaciones de rutas
#+INCLUDE: "capitulos/01-introduccion.org" :minlevel 1
#+INCLUDE: "capitulos/02-marco-teorico.org" :minlevel 1
ORG
cat > "$THESIS/capitulos/01-introduccion.org" <<'ORG'
* Introducción
:PROPERTIES:
:CUSTOM_ID: cap-introduccion
:END:

La analítica de datos de viajes se está incorporando con rapidez al
planificación del transporte público. Esto genera un modelo que se integra sin una revisión
formal suficiente y que empieza a producir rutas poco eficientes en operación
[cite:@example2024routes]. Los equipos necesitan un método para documentar esos
incidentes de manera trazable y reproducible.
ORG
cat > "$THESIS/capitulos/02-marco-teorico.org" <<'ORG'
* Marco teórico

Una ruta de transporte público es una secuencia ordenada de paradas
servidas por una o más líneas.
ORG
cp "$WORK/v1.pdf" "$THESIS/tesis.pdf"
cp "$WORK/v1.avance.json" "$THESIS/avance.json"
cat > "$THESIS/.doc-review.json" <<'JSON'
{"document": "thesis", "pdf": "tesis.pdf", "progress": "avance.json",
 "sources": ["tesis.org", "capitulos/*.org"]}
JSON

step "CLI: documents"
$CLI documents create thesis "Método computacional para la generación trazable de recomendaciones de rutas" --language es --default-role "Director(a)"
$CLI documents create report "Incident review: the October outage" --language en --default-role Reviewer
$CLI documents list

step "CLI: publish (the thesis from its project, the report by hand, twice)"
(cd "$THESIS/capitulos" && $CLI publish -m "Primera versión para revisión")
$CLI publish -d report "$WORK/r1.pdf" "$WORK/r1.progress.json" -m "First draft for ACME"
$CLI publish -d report "$WORK/r2.pdf" "$WORK/r2.progress.json" -m "Timeline and actions updated"

step "CLI: people and invitations"
ANA_ID=$($CLI people add "Dra. Ana Torres Ruiz" --email director@example.test --replies instant --versions | sed -n 's/^person \([0-9]*\):.*/\1/p')
ANA_THESIS=$(cd "$THESIS" && $CLI invite --person "$ANA_ID" | grep -o 'http://[^ ]*')
ANA_REPORT=$($CLI invite -d report --person "$ANA_ID" --role Reviewer | grep -o 'http://[^ ]*')
LUIS=$($CLI invite -d thesis "Dr. Luis Méndez Ortega" --email codirector@example.test --role "Codirector(a)" | grep -o 'http://[^ ]*')
$CLI people list
(cd "$THESIS" && $CLI invitations list)

step "reviewers in their browsers (API): comments, replies, resolve rules"
export BASE ANA_THESIS LUIS
node "$REPO/scripts/smoke-reviewers.mjs" comment | tee "$WORK/reviewers.out"

step "visibility: «own» on the thesis, then «all» again"
$CLI documents set thesis --visibility own
node "$REPO/scripts/smoke-reviewers.mjs" visibility-own
$CLI documents set thesis --visibility all
node "$REPO/scripts/smoke-reviewers.mjs" visibility-all

step "Emacs (batch): publish v2 from the thesis project"
cp "$WORK/v2.pdf" "$THESIS/tesis.pdf"
cp "$WORK/v2.avance.json" "$THESIS/avance.json"
(cd "$THESIS/capitulos" && emacs -Q --batch -L "$REPO/emacs" -l doc-review \
  --eval "(setq doc-review-config-file \"$DOC_REVIEW_CONFIG\")" \
  --eval '(doc-review-publish "Atendí la observación del capítulo 1")')
sleep 1

if [ -n "${CHROME:-}" ]; then
  step "browser: reviewers and owner in Chromium, screenshots"
  BASE=$BASE ANA_LINK=$ANA_REPORT LUIS_LINK=$LUIS OWNER_TOKEN=$TOKEN CHROME=$CHROME node "$REPO/scripts/screenshots.mjs"
fi

step "CLI: comments of the thesis (from its project) and of the report"
(cd "$THESIS" && $CLI comments)
$CLI comments -d report --all

step "Emacs (batch): comments buffer anchored in the org sources, reply and resolve"
(cd "$THESIS" && emacs -Q --batch -L "$REPO/emacs" -l doc-review \
  --eval "(setq doc-review-config-file \"$DOC_REVIEW_CONFIG\")" \
  --eval '(progn
            (let* ((threads (doc-review-comments))
                   (text (with-current-buffer "*doc-review: thesis*" (buffer-string))))
              (princ text)
              (unless (string-match-p "Source: \\[\\[file:.*01-introduccion\\.org::7\\]" text)
                (error "the comment is not anchored in 01-introduccion.org:7"))
              (let ((id (alist-get (quote id) (car threads))))
                (doc-review-reply id "Gracias, doctor: agrego la referencia.")
                (doc-review-resolve id))))') > "$WORK/emacs.out"
cat "$WORK/emacs.out"
ok "Emacs anchored the comment at capitulos/01-introduccion.org:7"

step "CLI: comments after resolving (open only, then all)"
(cd "$THESIS" && $CLI comments)
(cd "$THESIS" && $CLI comments --all | head -20)

step "email notifications (fake SMTP)"
sleep 1
mails() { jq -r --arg to "$1" 'select(.to | index($to)) | .subject' "$MAILS"; }
mails owner@example.test | grep -q "Comentario nuevo de Dra. Ana Torres Ruiz (Director(a))" || fail "owner: new comment email (Spanish, with the role)"
ok "the owner got the new-comment email, in Spanish, with the role"
mails owner@example.test | grep -q "New comment from Dra. Ana Torres Ruiz (Reviewer)" || fail "owner: the report's comment in English"
ok "…and the report's comment in English"
mails director@example.test | grep -q "Respuesta de Dr. Luis Méndez Ortega" || fail "Ana: reply email"
ok "Ana got Luis's reply at once (he asked for instant emails)"
mails director@example.test | grep -q "Nueva versión (v2)" || fail "Ana: version email"
ok "Ana got the new-version email (he asked for it)"
mails codirector@example.test | grep -q . && fail "Luis got email he didn't ask for"
ok "Luis got nothing (notifications off by default)"
if jq -r .text "$MAILS" | grep -q "/a/"; then fail "a secret link in an email"; fi
ok "no email carries a personal link"

step "server log (no secrets expected)"
cat "$WORK/server.log"
for secret in "$TOKEN" "${ANA_THESIS##*/}" "${ANA_REPORT##*/}" "${LUIS##*/}"; do
  if grep -q -e "$secret" "$WORK/server.log"; then fail "secret in the log"; fi
done
ok "no token or link in the log"
echo "smoke OK ($WORK)"
