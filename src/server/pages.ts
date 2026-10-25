// Server-rendered pages (Spanish UI). Every interpolated value goes through `esc`.
// No inline scripts or styles: the CSP only allows 'self'.

import type { Avance } from "../avance.js";
import type { VersionDiff } from "../diff.js";
import type { Director, Version, Visibility } from "../repo.js";
import { esc } from "../text.js";

export interface Layout {
  title: string;
  who?: { kind: "owner" | "director"; name: string } | null;
  csrf?: string;
  scripts?: string[];
  bodyClass?: string;
  data?: Record<string, string | number>;
}

const STATUS_LABEL: Record<string, string> = {
  borrador: "Borrador",
  revision: "En revisión",
  terminado: "Terminado",
};

const dateFmt = new Intl.DateTimeFormat("es-MX", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: process.env.TZ || "America/Mexico_City",
});
export const fmtDate = (d: Date | string) => dateFmt.format(new Date(d));
const num = (n: number) => n.toLocaleString("es-MX");

export function page(l: Layout, body: string): string {
  const data = Object.entries(l.data ?? {})
    .map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`)
    .join("");
  const nav = l.who
    ? `<nav class="top">
        <a class="brand" href="/">Revisión de tesis</a>
        <span class="who">${esc(l.who.name)}${l.who.kind === "owner" ? " · autor" : ""}</span>
        <form method="post" action="/salir" class="inline">
          <input type="hidden" name="_csrf" value="${esc(l.csrf ?? "")}">
          <button type="submit" class="link">Salir</button>
        </form>
      </nav>`
    : `<nav class="top"><span class="brand">Revisión de tesis</span></nav>`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${l.csrf ? `<meta name="csrf-token" content="${esc(l.csrf)}">` : ""}
<title>${esc(l.title)}</title>
<link rel="stylesheet" href="/static/app.css">
${(l.scripts ?? []).map((s) => `<script type="module" src="${esc(s)}"></script>`).join("\n")}
</head>
<body class="${esc(l.bodyClass ?? "")}"${data}>
${nav}
${body}
</body>
</html>`;
}

export function messagePage(title: string, message: string, extra = ""): string {
  return page({ title }, `<main class="narrow"><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main>`);
}

export function landingPage(): string {
  return page(
    { title: "Revisión de tesis" },
    `<main class="narrow">
      <h1>Revisión de tesis</h1>
      <p>Este sitio es privado. Para revisar la tesis, abra el enlace personal que recibió.</p>
      <p class="muted"><a href="/entrar">Acceso del autor</a></p>
    </main>`,
  );
}

export function loginPage(pre: string, error = ""): string {
  return page(
    { title: "Entrar" },
    `<main class="narrow">
      <h1>Acceso del autor</h1>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <form method="post" action="/entrar" class="stack">
        <input type="hidden" name="_csrf" value="${esc(pre)}">
        <label>Token de autor
          <input type="password" name="token" autocomplete="current-password" required autofocus>
        </label>
        <button type="submit">Entrar</button>
      </form>
      <p class="muted">El token está en <code>~/.config/revision-tesis/config.json</code>. Solo se pide una vez por navegador.</p>
    </main>`,
  );
}

function progressTable(avance: Avance, prev: Avance | null): string {
  const prevWords = new Map(prev?.chapters.map((c) => [c.id, c.words]) ?? []);
  const rows = avance.chapters
    .map((c) => {
      const pct = c.goal ? Math.min(100, Math.round((c.words / c.goal) * 100)) : null;
      const before = prevWords.get(c.id);
      const delta = before === undefined ? null : c.words - before;
      return `<tr>
        <td>${esc(c.title)}</td>
        <td class="num">${num(c.words)}</td>
        <td class="num">${delta === null ? "—" : `<span class="${delta > 0 ? "plus" : delta < 0 ? "minus" : ""}">${delta > 0 ? "+" : ""}${num(delta)}</span>`}</td>
        <td class="num">${c.goal ? num(c.goal) : "—"}</td>
        <td>${pct === null ? "" : `<progress max="100" value="${pct}"></progress> <span class="muted">${pct} %</span>`}</td>
        <td>${c.status ? `<span class="tag tag-${esc(c.status)}">${esc(STATUS_LABEL[c.status] ?? c.status)}</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  return `<table class="progress">
    <thead><tr><th>Capítulo</th><th class="num">Palabras</th><th class="num">Cambio</th><th class="num">Meta</th><th>Avance</th><th>Estado</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${num(avance.total_words)}</th><th class="num">${prev ? `${avance.total_words - prev.total_words >= 0 ? "+" : ""}${num(avance.total_words - prev.total_words)}` : "—"}</th><th colspan="3"></th></tr></tfoot>
  </table>`;
}

function diffHtml(diff: VersionDiff | null): string {
  if (!diff) return `<p class="muted">Es la primera versión: no hay cambios que mostrar.</p>`;
  const sections = diff.chapters
    .filter((c) => c.hunks === null || c.hunks.length > 0 || (c.words_delta ?? 0) !== 0)
    .map((c) => {
      const head = `<summary><strong>${esc(c.title)}</strong>
        ${c.words_delta === null ? "" : `<span class="${c.words_delta > 0 ? "plus" : c.words_delta < 0 ? "minus" : "muted"}">${c.words_delta > 0 ? "+" : ""}${num(c.words_delta)} palabras</span>`}
        ${c.hunks ? `<span class="muted">· ${c.added} oraciones nuevas, ${c.removed} quitadas</span>` : ""}</summary>`;
      const body =
        c.hunks === null
          ? `<p class="muted">El texto cambió demasiado para compararlo oración por oración.</p>`
          : c.hunks.length === 0
            ? `<p class="muted">Sin cambios en el texto del PDF.</p>`
            : c.hunks
                .map(
                  (h) =>
                    `<div class="hunk">${h
                      .map((o) => `<p class="d-${o.op}">${o.op === "add" ? "+ " : o.op === "del" ? "− " : ""}${esc(o.text)}</p>`)
                      .join("")}</div>`,
                )
                .join("");
      return `<details class="chapter-diff">${head}${body}</details>`;
    })
    .join("");
  return `<p class="muted">Comparada con la versión ${diff.previous}${diff.mode === "document" ? " (no se ubicaron los capítulos en el PDF: comparación del documento completo)" : ""}.</p>${sections || `<p class="muted">Sin cambios.</p>`}`;
}

export function changesPage(
  l: Layout,
  v: Version,
  prev: Version | null,
  diff: VersionDiff | null,
): string {
  return page(
    l,
    `<main class="wide">
      <p><a href="/v/${v.number}">← Volver al PDF</a></p>
      <h1>Versión ${v.number}: avance y cambios</h1>
      <p class="muted">Publicada el ${esc(fmtDate(v.created_at))} · ${v.page_count} páginas</p>
      ${v.note ? `<blockquote class="note">${esc(v.note)}</blockquote>` : ""}
      <h2>Avance por capítulo</h2>
      ${progressTable(v.avance, prev?.avance ?? null)}
      <h2>Qué cambió</h2>
      ${diffHtml(diff)}
    </main>`,
  );
}

export function viewerPage(l: Layout, v: Version, versions: Version[]): string {
  const options = versions
    .map((x) => `<option value="${x.number}"${x.number === v.number ? " selected" : ""}>Versión ${x.number} · ${esc(fmtDate(x.created_at))}</option>`)
    .join("");
  return page(
    { ...l, bodyClass: "viewer", scripts: ["/static/viewer.js"], data: { version: v.number, pages: v.page_count, role: l.who?.kind ?? "" } },
    `<div class="viewer-bar">
      <label class="inline">Versión
        <select id="version-select">${options}</select>
      </label>
      <a href="/v/${v.number}/cambios">Avance y cambios</a>
      <button type="button" id="point-mode" aria-pressed="false" title="Haga clic en un lugar de la página para comentar ahí">Comentar un punto</button>
      <span class="muted hint">Seleccione texto en el PDF para comentarlo.</span>
      <span class="spacer"></span>
      <label class="inline"><input type="checkbox" id="show-resolved"> Mostrar resueltos</label>
      <button type="button" id="zoom-out" aria-label="Alejar">−</button>
      <button type="button" id="zoom-in" aria-label="Acercar">+</button>
    </div>
    ${v.note ? `<div class="version-note"><strong>Nota de la versión ${v.number}:</strong> ${esc(v.note)}</div>` : ""}
    <div class="viewer-main">
      <div id="pages" class="pages" aria-label="Páginas del PDF"></div>
      <aside id="threads" class="threads" aria-label="Comentarios">
        <h2>Comentarios</h2>
        <div id="thread-list"><p class="muted">Cargando…</p></div>
      </aside>
    </div>
    <div id="composer" class="composer" hidden>
      <form id="composer-form" class="stack">
        <p class="quote" id="composer-quote"></p>
        <label>Comentario
          <textarea name="body" rows="5" maxlength="10000" required></textarea>
        </label>
        <p class="muted small">Formato: **negritas**, *cursivas*, \`código\`. Los enlaces se muestran tal cual.</p>
        <div class="row">
          <button type="submit">Publicar comentario</button>
          <button type="button" class="secondary" id="composer-cancel">Cancelar</button>
        </div>
      </form>
    </div>
    <button type="button" id="selection-button" class="selection-button" hidden>Comentar selección</button>`,
  );
}

export function ownerDashboard(
  l: Layout,
  input: {
    versions: Version[];
    openByVersion: Map<number, number>;
    directors: Director[];
    visibility: Visibility;
    channels: { telegram: boolean; ownerEmail: boolean; directorEmail: boolean; digest: string | null };
    publicUrl: string;
    maxPdfMb: number;
  },
): string {
  const latest = input.versions[0] ?? null;
  const prev = input.versions[1] ?? null;
  const versions = input.versions
    .map(
      (v) => `<tr>
        <td><a href="/v/${v.number}">Versión ${v.number}</a></td>
        <td>${esc(fmtDate(v.created_at))}</td>
        <td class="num">${v.page_count}</td>
        <td class="num">${num(v.avance.total_words)}</td>
        <td class="num">${input.openByVersion.get(v.number) ?? 0}</td>
        <td>${esc(v.note)}</td>
        <td><a href="/v/${v.number}/cambios">cambios</a></td>
      </tr>`,
    )
    .join("");
  const directors = input.directors
    .map(
      (d) => `<tr data-id="${d.id}">
        <td>${esc(d.name)}<div class="muted small">${esc(d.role)}</div></td>
        <td>${d.email ? esc(d.email) : `<span class="muted">—</span>`}${d.notify_versions ? `<div class="small">avisos de versión</div>` : ""}</td>
        <td>${d.revoked_at ? `<span class="tag tag-revoked">Revocado</span>` : `<span class="tag tag-terminado">Activo</span>`}</td>
        <td class="small">${d.last_seen_at ? esc(fmtDate(d.last_seen_at)) : `<span class="muted">nunca</span>`}</td>
        <td class="actions">
          <button type="button" class="secondary" data-action="rotate" data-id="${d.id}" data-name="${esc(d.name)}">${d.revoked_at ? "Reactivar con enlace nuevo" : "Enlace nuevo"}</button>
          ${d.revoked_at ? "" : `<button type="button" class="danger" data-action="revoke" data-id="${d.id}" data-name="${esc(d.name)}">Revocar</button>`}
          <button type="button" class="secondary" data-action="edit" data-id="${d.id}" data-name="${esc(d.name)}" data-email="${esc(d.email ?? "")}" data-notify="${d.notify_versions ? "1" : ""}">Correo</button>
        </td>
      </tr>`,
    )
    .join("");
  const ch = input.channels;
  return page(
    { ...l, scripts: ["/static/admin.js"], data: { "max-pdf-mb": input.maxPdfMb } },
    `<main class="wide">
      <h1>Tu tesis</h1>
      ${latest ? `<p class="lead">${esc(latest.title)}</p>` : `<p>Aún no has publicado ninguna versión. Usa <code>revision-tesis publish</code>, Emacs (<code>revision-tesis-publicar</code>) o el formulario de abajo.</p>`}

      ${latest ? `<section><h2>Avance (versión ${latest.number})</h2>${progressTable(latest.avance, prev?.avance ?? null)}</section>` : ""}

      <section>
        <h2>Versiones</h2>
        ${versions ? `<table><thead><tr><th>Versión</th><th>Fecha</th><th class="num">Páginas</th><th class="num">Palabras</th><th class="num">Abiertos</th><th>Nota</th><th></th></tr></thead><tbody>${versions}</tbody></table>` : `<p class="muted">Sin versiones.</p>`}
        <details class="box">
          <summary>Publicar una versión desde el navegador</summary>
          <form id="upload-form" class="stack">
            <label>PDF compilado (máx. ${input.maxPdfMb} MB) <input type="file" name="pdf" accept="application/pdf" required></label>
            <label>avance.json <input type="file" name="avance" accept="application/json,.json" required></label>
            <label>Nota de la versión (opcional) <textarea name="note" rows="3" maxlength="5000"></textarea></label>
            <button type="submit">Publicar versión</button>
            <p id="upload-status" class="muted" role="status"></p>
          </form>
        </details>
      </section>

      <section>
        <h2>Directores</h2>
        <p class="muted">Cada director entra con su enlace personal. El enlace se muestra una sola vez; si se pierde, genera uno nuevo (el anterior deja de funcionar).</p>
        ${directors ? `<table class="directors"><thead><tr><th>Nombre</th><th>Correo</th><th>Estado</th><th>Última visita</th><th></th></tr></thead><tbody>${directors}</tbody></table>` : `<p class="muted">Aún no hay directores.</p>`}
        <details class="box">
          <summary>Agregar director</summary>
          <form id="director-form" class="stack">
            <label>Nombre <input name="name" required maxlength="200" placeholder="Dra. Ana Torres Ruiz"></label>
            <label>Rol <input name="role" maxlength="100" placeholder="Director"></label>
            <label>Correo (opcional) <input type="email" name="email" maxlength="320"></label>
            <label class="check"><input type="checkbox" name="notify_versions"> Avisarle por correo cuando publique una versión nueva</label>
            <label class="check"><input type="checkbox" name="send_link"> Enviar enlace por correo</label>
            <button type="submit">Crear enlace</button>
          </form>
        </details>
        <div id="link-result" class="link-result" hidden role="status"></div>
      </section>

      <section>
        <h2>Ajustes</h2>
        <form id="settings-form" class="stack">
          <fieldset>
            <legend>Qué comentarios ve cada director</legend>
            <label class="check"><input type="radio" name="visibility" value="all"${input.visibility === "all" ? " checked" : ""}> Todos (colaboran entre ellos)</label>
            <label class="check"><input type="radio" name="visibility" value="own"${input.visibility === "own" ? " checked" : ""}> Solo los suyos y los tuyos</label>
          </fieldset>
          <button type="submit">Guardar</button>
          <span id="settings-status" class="muted" role="status"></span>
        </form>
        <h3>Avisos</h3>
        <ul class="channels">
          <li>Telegram: ${ch.telegram ? "activo" : "desactivado (TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID)"}</li>
          <li>Correo para ti: ${ch.ownerEmail ? "activo" : "desactivado (SMTP_* y EMAIL_OWNER_TO)"}</li>
          <li>Correo a directores: ${ch.directorEmail ? "disponible (solo a quienes tengan correo y avisos activados)" : "desactivado (SMTP_*)"}</li>
          <li>Resumen diario: ${ch.digest ? esc(ch.digest) : "desactivado (DIGEST_HOUR)"}</li>
        </ul>
      </section>
    </main>`,
  );
}
