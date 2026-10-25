// The PDF viewer with its comment threads, and a version's progress and changes.

import type { VersionDiff } from "../../diff.js";
import type { Document, Version } from "../../repo.js";
import { esc } from "../../text.js";
import { diffHtml, progressTable } from "./common.js";
import { page, type Layout } from "./layout.js";

export function viewerPage(l: Layout, doc: Document, v: Version, versions: Version[]): string {
  const tr = l.tr;
  const options = versions
    .map((x) => `<option value="${x.number}"${x.number === v.number ? " selected" : ""}>${tr.e("viewer.version_option", { n: x.number, date: tr.date(x.created_at) })}</option>`)
    .join("");
  const base = `/d/${esc(doc.slug)}`;
  return page(
    {
      ...l,
      bodyClass: "viewer",
      scripts: ["/static/viewer.js"],
      data: { document: doc.slug, version: v.number, pages: v.page_count, role: l.who?.kind ?? "", archived: doc.archived_at ? "1" : "" },
    },
    `<div class="viewer-bar">
      <label class="inline">${tr.e("viewer.version")}
        <select id="version-select">${options}</select>
      </label>
      <a href="${base}/v/${v.number}/changes">${tr.e("viewer.changes_link")}</a>
      ${
        doc.archived_at
          ? `<span class="tag tag-revoked">${tr.e("doc.archived")}</span>`
          : `<button type="button" id="point-mode" aria-pressed="false" title="${tr.e("viewer.point_title")}">${tr.e("viewer.point_mode")}</button>
      <span class="muted hint">${tr.e("viewer.hint")}</span>`
      }
      <span class="spacer"></span>
      <label class="inline"><input type="checkbox" id="show-resolved"> ${tr.e("viewer.show_resolved")}</label>
      <button type="button" id="zoom-out" aria-label="${tr.e("viewer.zoom_out")}">−</button>
      <button type="button" id="zoom-in" aria-label="${tr.e("viewer.zoom_in")}">+</button>
    </div>
    ${v.note ? `<div class="version-note"><strong>${tr.e("viewer.note", { n: v.number })}</strong> ${esc(v.note)}</div>` : ""}
    <div class="viewer-main">
      <div id="pages" class="pages" aria-label="${tr.e("viewer.pages")}"></div>
      <aside id="threads" class="threads" aria-label="${tr.e("viewer.comments")}">
        <h2>${tr.e("viewer.comments")}</h2>
        <div id="thread-list"><p class="muted">${tr.e("viewer.loading")}</p></div>
      </aside>
    </div>
    <div id="composer" class="composer" hidden>
      <form id="composer-form" class="stack">
        <p class="quote" id="composer-quote"></p>
        <label>${tr.e("viewer.comment")}
          <textarea name="body" rows="5" maxlength="10000" required></textarea>
        </label>
        <p class="muted small">${tr.e("viewer.format_help")}</p>
        <div class="row">
          <button type="submit">${tr.e("viewer.publish_comment")}</button>
          <button type="button" class="secondary" id="composer-cancel">${tr.e("common.cancel")}</button>
        </div>
      </form>
    </div>
    <button type="button" id="selection-button" class="selection-button" hidden>${tr.e("viewer.comment_selection")}</button>`,
  );
}

export function changesPage(l: Layout, doc: Document, v: Version, prev: Version | null, diff: VersionDiff | null): string {
  const tr = l.tr;
  return page(
    l,
    `<main class="wide">
      <p><a href="/d/${esc(doc.slug)}/v/${v.number}">${tr.e("changes.back")}</a></p>
      <h1>${tr.e("changes.title", { n: v.number })}</h1>
      <p class="muted">${tr.e("changes.published", { date: tr.date(v.created_at), pages: v.page_count })}</p>
      ${v.note ? `<blockquote class="note">${esc(v.note)}</blockquote>` : ""}
      <h2>${tr.e("changes.progress")}</h2>
      ${progressTable(tr, v.progress, prev?.progress ?? null)}
      <h2>${tr.e("changes.what_changed")}</h2>
      ${diffHtml(tr, diff)}
    </main>`,
  );
}
