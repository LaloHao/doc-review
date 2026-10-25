// The owner's pages: the dashboard (documents, people, channels, sessions) and a
// document's management page (versions, reviewers, settings).

import { LANGS, type Lang, type Tr } from "../../i18n/index.js";
import type { Document, DocumentSummary, InvitationWithDocument, InvitationWithPerson, Person, Version, Visibility } from "../../repo.js";
import { REPLY_NOTIFY, VISIBILITIES } from "../../repo.js";
import { esc } from "../../text.js";
import { progressSummary, progressTable, REPLY_KEY, roleDatalist, VISIBILITY_KEY } from "./common.js";
import { page, type Layout } from "./layout.js";

const LANG_KEY = { en: "lang.en", es: "lang.es" } as const;

function langOptions(tr: Tr, selected: Lang): string {
  return LANGS.map((l) => `<option value="${l}"${l === selected ? " selected" : ""}>${tr.e(LANG_KEY[l])}</option>`).join("");
}

function visibilityRadios(tr: Tr, selected: Visibility): string {
  return VISIBILITIES.map(
    (v) => `<label class="check"><input type="radio" name="visibility" value="${v}"${v === selected ? " checked" : ""}> ${tr.e(VISIBILITY_KEY[v])}</label>`,
  ).join("");
}

export interface Channels {
  telegram: boolean;
  ownerEmail: boolean;
  reviewerEmail: boolean;
  digestHour: number | null;
  timeZone: string;
}

function channelsList(tr: Tr, ch: Channels): string {
  return `<ul class="channels">
    <li>${tr.e("channels.telegram")}: ${tr.e(ch.telegram ? "channels.on" : "channels.telegram_off")}</li>
    <li>${tr.e("channels.owner_email")}: ${tr.e(ch.ownerEmail ? "channels.on" : "channels.owner_email_off")}</li>
    <li>${tr.e("channels.reviewer_email")}: ${tr.e(ch.reviewerEmail ? "channels.reviewer_email_on" : "channels.smtp_off")}</li>
    <li>${tr.e("channels.digest")}: ${ch.digestHour === null ? tr.e("channels.digest_off") : tr.e("channels.digest_at", { hour: ch.digestHour, tz: ch.timeZone })}</li>
  </ul>`;
}

export function ownerDashboard(
  l: Layout,
  input: {
    summaries: DocumentSummary[];
    people: Person[];
    invitations: InvitationWithDocument[];
    channels: Channels;
  },
): string {
  const tr = l.tr;
  const docRow = (s: DocumentSummary) => {
    const d = s.document;
    return `<tr${d.archived_at ? ` class="archived"` : ""}>
      <td><a href="/d/${esc(d.slug)}/manage"><strong>${esc(d.title)}</strong></a><div class="muted small">${esc(d.slug)} · ${tr.e(LANG_KEY[d.language])}${d.archived_at ? ` · ${tr.e("doc.archived")}` : ""}</div></td>
      <td>${s.latest ? `<a href="/d/${esc(d.slug)}/v/${s.latest.number}">${tr.e("dash.version_n", { n: s.latest.number })}</a><div class="muted small">${esc(tr.date(s.latest.created_at))}</div>` : `<span class="muted">${tr.e("dash.no_versions")}</span>`}</td>
      <td>${progressSummary(tr, s.latest?.progress ?? null)}</td>
      <td class="num">${tr.num(s.open_threads)}</td>
      <td class="num">${tr.num(s.reviewers)}</td>
    </tr>`;
  };
  const docsOf = new Map<number, InvitationWithDocument[]>();
  for (const i of input.invitations) docsOf.set(i.person_id, [...(docsOf.get(i.person_id) ?? []), i]);
  const personRow = (p: Person) => `<tr data-id="${p.id}">
      <td>${esc(p.name)}<div class="muted small">${p.email ? esc(p.email) : "—"}</div></td>
      <td class="small">${
        (docsOf.get(p.id) ?? [])
          .map((i) => `<div${i.revoked_at ? ` class="muted"` : ""}><a href="/d/${esc(i.document.slug)}/manage">${esc(i.document.title)}</a>${i.role ? ` · ${esc(i.role)}` : ""}${i.revoked_at ? ` · ${tr.e("inv.revoked")}` : ""}</div>`)
          .join("") || `<span class="muted">${tr.e("people.no_documents")}</span>`
      }</td>
      <td><select data-action="notify-replies" data-id="${p.id}" aria-label="${tr.e("people.replies_for", { name: p.name })}">
          ${REPLY_NOTIFY.map((v) => `<option value="${v}"${p.notify_replies === v ? " selected" : ""}>${tr.e(REPLY_KEY[v])}</option>`).join("")}
        </select>
        <label class="check small"><input type="checkbox" data-action="notify-versions" data-id="${p.id}"${p.notify_versions ? " checked" : ""}> ${tr.e("people.versions")}</label></td>
      <td class="small">${p.last_seen_at ? esc(tr.date(p.last_seen_at)) : `<span class="muted">${tr.e("people.never")}</span>`}</td>
      <td class="actions"><button type="button" class="secondary" data-action="edit-person" data-id="${p.id}" data-name="${esc(p.name)}" data-email="${esc(p.email ?? "")}">${tr.e("people.edit")}</button></td>
    </tr>`;
  const active = input.summaries.filter((s) => !s.document.archived_at);
  const archived = input.summaries.filter((s) => s.document.archived_at);
  const docTable = (rows: DocumentSummary[]) =>
    `<table class="documents"><thead><tr><th>${tr.e("dash.document")}</th><th>${tr.e("dash.latest")}</th><th>${tr.e("dash.progress")}</th><th class="num">${tr.e("dash.open")}</th><th class="num">${tr.e("dash.reviewers")}</th></tr></thead><tbody>${rows.map(docRow).join("")}</tbody></table>`;
  return page(
    { ...l, scripts: ["/static/admin.js"] },
    `<main class="wide">
      <h1>${tr.e("dash.title")}</h1>
      ${active.length ? docTable(active) : `<p>${tr.html("dash.empty", { cli: "<code>doc-review documents create</code>" })}</p>`}
      ${archived.length ? `<details class="box"><summary>${tr.e("dash.archived", { n: archived.length })}</summary>${docTable(archived)}</details>` : ""}
      <details class="box"${input.summaries.length ? "" : " open"}>
        <summary>${tr.e("dash.new_document")}</summary>
        <form id="document-form" class="stack">
          <label>${tr.e("doc.field_title")} <input name="title" required maxlength="300"></label>
          <label>${tr.e("doc.field_slug")} <input name="slug" required maxlength="63" pattern="[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?" placeholder="my-thesis"><span class="muted small">${tr.e("doc.slug_hint")}</span></label>
          <label>${tr.e("doc.field_language")} <select name="language">${langOptions(tr, tr.lang)}</select></label>
          <fieldset><legend>${tr.e("doc.field_visibility")}</legend>${visibilityRadios(tr, "all")}</fieldset>
          <label>${tr.e("doc.field_default_role")} <input name="default_role" maxlength="100" list="role-suggestions"></label>
          ${roleDatalist(tr)}
          <button type="submit">${tr.e("dash.create")}</button>
        </form>
      </details>

      <section>
        <h2>${tr.e("people.title")}</h2>
        <p class="muted">${tr.e("people.intro")}</p>
        ${input.people.length ? `<table class="people"><thead><tr><th>${tr.e("people.name")}</th><th>${tr.e("people.documents")}</th><th>${tr.e("people.notifications")}</th><th>${tr.e("people.last_visit")}</th><th></th></tr></thead><tbody>${input.people.map(personRow).join("")}</tbody></table>` : `<p class="muted">${tr.e("people.none")}</p>`}
        <details class="box">
          <summary>${tr.e("people.add")}</summary>
          <form id="person-form" class="stack">
            <label>${tr.e("people.name")} <input name="name" required maxlength="200"></label>
            <label>${tr.e("people.email_optional")} <input type="email" name="email" maxlength="320"></label>
            <button type="submit">${tr.e("people.add_submit")}</button>
          </form>
        </details>
      </section>

      <section>
        <h2>${tr.e("channels.title")}</h2>
        ${channelsList(tr, input.channels)}
        <h3>${tr.e("sessions.title")}</h3>
        <form id="sessions-form" class="stack">
          <p class="muted">${tr.e("sessions.intro")}</p>
          <label class="check"><input type="checkbox" name="reviewers"> ${tr.e("sessions.reviewers_too")}</label>
          <button type="submit" class="danger">${tr.e("sessions.close_all")}</button>
        </form>
      </section>
    </main>`,
  );
}

export function documentManagePage(
  l: Layout,
  input: {
    doc: Document;
    versions: Version[];
    openByVersion: Map<number, number>;
    invitations: InvitationWithPerson[];
    people: Person[];
    maxPdfMb: number;
  },
): string {
  const tr = l.tr;
  const { doc } = input;
  const base = `/d/${esc(doc.slug)}`;
  const latest = input.versions[0] ?? null;
  const prev = input.versions[1] ?? null;
  const versions = input.versions
    .map(
      (v) => `<tr>
        <td><a href="${base}/v/${v.number}">${tr.e("dash.version_n", { n: v.number })}</a></td>
        <td>${esc(tr.date(v.created_at))}</td>
        <td class="num">${tr.num(v.page_count)}</td>
        <td class="num">${v.progress ? tr.num(v.progress.total_words) : "—"}</td>
        <td class="num">${tr.num(input.openByVersion.get(v.number) ?? 0)}</td>
        <td>${esc(v.note)}</td>
        <td><a href="${base}/v/${v.number}/changes">${tr.e("manage.changes")}</a></td>
      </tr>`,
    )
    .join("");
  const invited = new Set(input.invitations.map((i) => i.person_id));
  const invRow = (i: InvitationWithPerson) => `<tr data-id="${i.id}">
      <td>${esc(i.person.name)}<div class="muted small">${i.person.email ? esc(i.person.email) : "—"}</div></td>
      <td>${i.role ? esc(i.role) : `<span class="muted">—</span>`}</td>
      <td>${i.revoked_at ? `<span class="tag tag-revoked">${tr.e("inv.revoked")}</span>` : `<span class="tag tag-done">${tr.e("inv.active")}</span>`}</td>
      <td class="small">${i.last_seen_at ? esc(tr.date(i.last_seen_at)) : `<span class="muted">${tr.e("people.never")}</span>`}</td>
      <td class="actions">
        <button type="button" class="secondary" data-action="rotate" data-id="${i.id}" data-name="${esc(i.person.name)}">${tr.e(i.revoked_at ? "inv.reactivate" : "inv.new_link")}</button>
        ${i.revoked_at ? "" : `<button type="button" class="danger" data-action="revoke" data-id="${i.id}" data-name="${esc(i.person.name)}">${tr.e("inv.revoke")}</button>`}
        <button type="button" class="secondary" data-action="role" data-id="${i.id}" data-name="${esc(i.person.name)}" data-role="${esc(i.role)}">${tr.e("inv.role")}</button>
      </td>
    </tr>`;
  const candidates = input.people.filter((p) => !invited.has(p.id));
  return page(
    { ...l, scripts: ["/static/admin.js"], data: { "max-pdf-mb": input.maxPdfMb, document: doc.slug } },
    `<main class="wide">
      <h1>${esc(doc.title)}</h1>
      <p class="muted">${esc(doc.slug)} · ${tr.e(LANG_KEY[doc.language])} · ${tr.e(VISIBILITY_KEY[doc.visibility])}${doc.archived_at ? ` · <span class="tag tag-revoked">${tr.e("doc.archived")}</span>` : ""}
        ${latest ? ` · <a href="${base}/v/${latest.number}">${tr.e("manage.open_viewer")}</a>` : ""}</p>

      ${latest ? `<section><h2>${tr.e("manage.progress", { n: latest.number })}</h2>${progressTable(tr, latest.progress, prev?.progress ?? null)}</section>` : `<p>${tr.html("manage.no_versions", { cli: "<code>doc-review publish</code>", emacs: "<code>doc-review-publish</code>" })}</p>`}

      <section>
        <h2>${tr.e("manage.versions")}</h2>
        ${versions ? `<table><thead><tr><th>${tr.e("manage.version")}</th><th>${tr.e("manage.date")}</th><th class="num">${tr.e("manage.pages")}</th><th class="num">${tr.e("progress.words")}</th><th class="num">${tr.e("dash.open")}</th><th>${tr.e("manage.note")}</th><th></th></tr></thead><tbody>${versions}</tbody></table>` : ""}
        ${
          doc.archived_at
            ? ""
            : `<details class="box">
          <summary>${tr.e("manage.upload")}</summary>
          <form id="upload-form" class="stack">
            <label>${tr.e("manage.pdf", { mb: input.maxPdfMb })} <input type="file" name="pdf" accept="application/pdf" required></label>
            <label>${tr.e("manage.progress_file")} <input type="file" name="progress" accept="application/json,.json"></label>
            <label>${tr.e("manage.note_optional")} <textarea name="note" rows="3" maxlength="5000"></textarea></label>
            <button type="submit">${tr.e("manage.publish")}</button>
            <p id="upload-status" class="muted" role="status"></p>
          </form>
        </details>`
        }
      </section>

      <section>
        <h2>${tr.e("manage.reviewers")}</h2>
        <p class="muted">${tr.e("manage.reviewers_intro")}</p>
        ${input.invitations.length ? `<table class="invitations"><thead><tr><th>${tr.e("people.name")}</th><th>${tr.e("home.role")}</th><th>${tr.e("inv.status")}</th><th>${tr.e("people.last_visit")}</th><th></th></tr></thead><tbody>${input.invitations.map(invRow).join("")}</tbody></table>` : `<p class="muted">${tr.e("manage.no_reviewers")}</p>`}
        ${
          doc.archived_at
            ? ""
            : `<details class="box">
          <summary>${tr.e("manage.invite")}</summary>
          <form id="invite-form" class="stack">
            ${
              candidates.length
                ? `<label>${tr.e("manage.invite_who")} <select name="person_id">
                <option value="">${tr.e("manage.invite_new")}</option>
                ${candidates.map((p) => `<option value="${p.id}">${esc(p.name)}${p.email ? ` (${esc(p.email)})` : ""}</option>`).join("")}
              </select></label>`
                : ""
            }
            <div class="new-person stack">
              <label>${tr.e("people.name")} <input name="name" maxlength="200"></label>
              <label>${tr.e("people.email_optional")} <input type="email" name="email" maxlength="320"></label>
            </div>
            <label>${tr.e("home.role")} <input name="role" maxlength="100" list="role-suggestions" value="${esc(doc.default_role)}"></label>
            ${roleDatalist(tr)}
            <label class="check"><input type="checkbox" name="send_link"> ${tr.e("manage.send_link")}</label>
            <button type="submit">${tr.e("manage.create_link")}</button>
          </form>
        </details>`
        }
        <div id="link-result" class="link-result" hidden role="status"></div>
      </section>

      <section>
        <h2>${tr.e("manage.settings")}</h2>
        <form id="doc-settings-form" class="stack">
          <label>${tr.e("doc.field_title")} <input name="title" required maxlength="300" value="${esc(doc.title)}"></label>
          <label>${tr.e("doc.field_slug")} <input name="slug" required maxlength="63" value="${esc(doc.slug)}"><span class="muted small">${tr.e("doc.slug_change_hint")}</span></label>
          <label>${tr.e("doc.field_language")} <select name="language">${langOptions(tr, doc.language)}</select></label>
          <fieldset><legend>${tr.e("doc.field_visibility")}</legend>${visibilityRadios(tr, doc.visibility)}</fieldset>
          <label>${tr.e("doc.field_default_role")} <input name="default_role" maxlength="100" list="role-suggestions" value="${esc(doc.default_role)}"></label>
          <button type="submit">${tr.e("common.save")}</button>
          <span id="settings-status" class="muted" role="status"></span>
        </form>
        <p><button type="button" id="archive-button" class="${doc.archived_at ? "secondary" : "danger"}" data-archived="${doc.archived_at ? "1" : ""}">${tr.e(doc.archived_at ? "manage.unarchive" : "manage.archive")}</button>
          <span class="muted small">${tr.e("manage.archive_hint")}</span></p>
      </section>
    </main>`,
  );
}
