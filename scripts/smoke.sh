#!/usr/bin/env bash
# End-to-end smoke test against a local server (no network beyond localhost):
# owner publishes with the CLI, creates director links, a director comments through
# the same API the browser uses (cookie + Origin + CSRF token), the owner publishes
# again from Emacs, reads the comments with the CLI and with Emacs (batch), and
# replies/resolves from Emacs. With CHROME=/path/to/chrome it also drives the real
# UI with playwright-core and refreshes docs/images.
#
#   pnpm build && scripts/smoke.sh
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d)}
PORT=${PORT:-8099}
BASE=http://localhost:$PORT
CLI="node $REPO/dist/cli.js"
export REVISION_TESIS_CONFIG=$WORK/config.json
mkdir -p "$WORK"

step() { printf '\n== %s\n' "$*"; }

step "owner token"
TOKEN_OUT=$($CLI gen-token)
TOKEN=$(echo "$TOKEN_OUT" | sed -n 2p | tr -d ' ')
SHA=$(echo "$TOKEN_OUT" | sed -n 4p | tr -d ' ')
printf '{"url":"%s","token":"%s"}' "$BASE" "$TOKEN" > "$REVISION_TESIS_CONFIG"
chmod 600 "$REVISION_TESIS_CONFIG"

step "server on $BASE (data in $WORK/data)"
PORT=$PORT HOST=127.0.0.1 PUBLIC_URL=$BASE DATA_DIR=$WORK/data OWNER_TOKEN_SHA256=$SHA \
  node "$REPO/dist/cli.js" serve > "$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -fs "$BASE/healthz" >/dev/null && break; sleep 0.2; done

step "sample thesis (org sources + PDFs)"
node "$REPO/test/fixtures/make-pdf.mjs" "$WORK/v1.pdf"
node "$REPO/test/fixtures/make-pdf.mjs" "$WORK/v2.pdf" v2
THESIS=$WORK/tesis
mkdir -p "$THESIS/capitulos"
cat > "$THESIS/tesis.org" <<'EOF'
#+TITLE: Método computacional para la generación trazable de recomendaciones de rutas
#+INCLUDE: "capitulos/01-introduccion.org" :minlevel 1
#+INCLUDE: "capitulos/02-marco-teorico.org" :minlevel 1
EOF
cat > "$THESIS/capitulos/01-introduccion.org" <<'EOF'
* Introducción
:PROPERTIES:
:CUSTOM_ID: cap-introduccion
:END:

La analítica de datos de viajes se está incorporando con rapidez al
planificación del transporte público. Esto genera un modelo que se integra sin una revisión
formal suficiente y que empieza a producir rutas poco eficientes en operación
[cite:@example2024routes]. Los equipos necesitan un método para documentar esos
incidentes de manera trazable y reproducible.
EOF
cat > "$THESIS/capitulos/02-marco-teorico.org" <<'EOF'
* Marco teórico

Una ruta de transporte público es una secuencia ordenada de paradas
servidas por una o más líneas.
EOF

step "CLI: publish v1, create director links"
$CLI publish "$WORK/v1.pdf" "$WORK/v1.avance.json" -m "Primera versión para revisión"
LINK1=$($CLI directors add "Dra. Ana Torres Ruiz" --role Director --email director@example.test --notify | grep -o 'http://[^ ]*')
LINK2=$($CLI directors add "Dr. Luis Méndez Ortega" --role Codirector | grep -o 'http://[^ ]*')
$CLI directors list

step "director: open the link, comment through the browser API"
JAR=$WORK/director.cookies
curl -s -o /dev/null -c "$JAR" -w 'link → %{http_code} %{redirect_url}\n' "$LINK1"
CSRF=$(curl -s -b "$JAR" "$BASE/api/me" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).csrf))')
curl -sf -b "$JAR" -H "origin: $BASE" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"version":1,"page":3,"anchor":"text","quote":"sin una revisión formal suficiente","rects":[{"x":0.4,"y":0.21,"w":0.3,"h":0.02}],"body":"Sugiero respaldar esta afirmación con una fuente reciente."}' \
  "$BASE/api/threads" | node -e 'process.stdin.on("data",d=>{const t=JSON.parse(d).thread;console.log("thread",t.id,"chapter",t.chapter.id)})'
echo -n "without CSRF token → "
curl -s -o /dev/null -w '%{http_code}\n' -b "$JAR" -H "origin: $BASE" -H 'content-type: application/json' -d '{}' "$BASE/api/threads"

step "Emacs: publish v2 from the thesis directory"
cp "$WORK/v2.pdf" "$THESIS/tesis.pdf"
cp "$WORK/v2.avance.json" "$THESIS/avance.json"
(cd "$THESIS/capitulos" && emacs -Q --batch -L "$REPO/emacs" -l revision-tesis \
  --eval "(setq revision-tesis-config-file \"$REVISION_TESIS_CONFIG\")" \
  --eval '(revision-tesis-publicar "Atendí la observación del capítulo 1")')

if [ -n "${CHROME:-}" ]; then
  step "browser: director and owner in Chromium, screenshots"
  BASE=$BASE DIRECTOR_LINK=$LINK2 OWNER_TOKEN=$TOKEN CHROME=$CHROME node "$REPO/scripts/screenshots.mjs"
fi

step "CLI: comments"
$CLI comments

step "Emacs: comments buffer (batch), reply and resolve"
(cd "$THESIS" && emacs -Q --batch -L "$REPO/emacs" -l revision-tesis \
  --eval "(setq revision-tesis-config-file \"$REVISION_TESIS_CONFIG\")" \
  --eval '(progn
            (let ((threads (revision-tesis-comentarios)))
              (with-current-buffer revision-tesis-buffer-name (princ (buffer-string)))
              (let ((id (alist-get (quote id) (car (last threads)))))
                (revision-tesis-responder id "Gracias, doctor: agrego la referencia.")
                (revision-tesis-resolver id))))')

step "CLI: comments after resolving (open only, then all)"
$CLI comments
$CLI comments --all | head -20

step "server log (no secrets expected)"
cat "$WORK/server.log"
if grep -q -e "$TOKEN" -e "${LINK1##*/}" "$WORK/server.log"; then echo "SECRET IN LOG" >&2; exit 1; fi
echo "smoke OK ($WORK)"
