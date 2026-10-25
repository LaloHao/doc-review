// Pages without a document or for reviewers: the landing page, the owner's
// login form, a reviewer's list of documents and notification settings, and
// the question before a link switches identities.

import type { Tr } from "../../i18n/index.js";
import type { DocumentSummary, InvitationWithDocument, ReplyNotify } from "../../repo.js";
import { esc } from "../../text.js";
import { REPLY_KEY } from "./common.js";
import { page, type Layout } from "./layout.js";

export function landingPage(tr: Tr): string {
  return page(
    { tr, title: tr("app.name") },
    `<main class="narrow">
      <h1>${tr.e("app.name")}</h1>
      <p>${tr.e("landing.private")}</p>
      <p class="muted"><a href="/login">${tr.e("landing.owner_login")}</a></p>
    </main>`,
  );
}

export function loginPage(tr: Tr, pre: string, error = ""): string {
  return page(
    { tr, title: tr("login.title") },
    `<main class="narrow">
      <h1>${tr.e("login.title")}</h1>
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="_csrf" value="${esc(pre)}">
        <label>${tr.e("login.token")}
          <input type="password" name="token" autocomplete="current-password" required autofocus>
        </label>
        <button type="submit">${tr.e("login.submit")}</button>
      </form>
      <p class="muted">${tr.html("login.hint", { path: "<code>~/.config/doc-review/config.json</code>" })}</p>
    </main>`,
  );
}

/** A link opened in a browser that has a session of someone else. */
export function switchIdentityPage(tr: Tr, current: string, next: string, secret: string, csrf: string): string {
  return page(
    { tr, title: tr("switch.title") },
    `<main class="narrow">
      <h1>${tr.e("switch.heading", { name: next })}</h1>
      <p>${tr.html("switch.body", { current: `<strong>${esc(current)}</strong>`, next: `<strong>${esc(next)}</strong>` })}</p>
      <form method="post" action="/a" class="row">
        <input type="hidden" name="_csrf" value="${esc(csrf)}">
        <input type="hidden" name="secret" value="${esc(secret)}">
        <button type="submit">${tr.e("switch.enter_as", { name: next })}</button>
        <a href="/">${tr.e("switch.stay_as", { name: current })}</a>
      </form>
    </main>`,
  );
}

/** A reviewer's documents (shown when they have more than one). */
export function reviewerHome(l: Layout, name: string, items: { invitation: InvitationWithDocument; summary: DocumentSummary }[]): string {
  const tr = l.tr;
  const row = ({ invitation: i, summary: s }: (typeof items)[number]) => `<tr>
      <td><a href="/d/${esc(i.document.slug)}">${esc(i.document.title)}</a>${i.document.archived_at ? ` <span class="tag tag-revoked">${tr.e("doc.archived")}</span>` : ""}</td>
      <td>${esc(i.role)}</td>
      <td>${s.latest ? tr.e("home.version_of", { n: s.latest.number, date: tr.date(s.latest.created_at) }) : `<span class="muted">${tr.e("home.no_versions")}</span>`}</td>
      <td class="num">${tr.num(s.open_threads)}</td>
    </tr>`;
  return page(
    l,
    `<main class="narrow">
      <h1>${tr.e("home.welcome", { name })}</h1>
      ${
        items.length
          ? `<p>${tr.e("home.your_documents")}</p>
        <table><thead><tr><th>${tr.e("home.document")}</th><th>${tr.e("home.role")}</th><th>${tr.e("home.latest")}</th><th class="num">${tr.e("home.open")}</th></tr></thead>
        <tbody>${items.map(row).join("")}</tbody></table>`
          : `<p>${tr.e("home.nothing")}</p>`
      }
    </main>`,
  );
}

/** A document without versions yet. */
export function noVersionsPage(l: Layout): string {
  const tr = l.tr;
  return page(l, `<main class="narrow"><h1>${esc(l.doc?.title ?? "")}</h1><p>${tr.e("doc.no_versions_reviewer")}</p></main>`);
}

export function notificationsPage(
  l: Layout,
  input: {
    replies: ReplyNotify;
    versions: boolean;
    email: string | null;
    mailEnabled: boolean;
    digestTime: string;
    saved: boolean;
    documents: InvitationWithDocument[];
  },
): string {
  const tr = l.tr;
  const radio = (v: ReplyNotify, extra = "") =>
    `<label class="check"><input type="radio" name="replies" value="${v}"${input.replies === v ? " checked" : ""}> ${tr.e(REPLY_KEY[v])}${extra ? ` (${esc(extra)})` : ""}</label>`;
  const where = !input.mailEnabled
    ? `<p class="muted">${tr.e("notif.mail_off")}</p>`
    : input.email
      ? `<p>${tr.html("notif.goes_to", { email: `<strong>${esc(input.email)}</strong>` })}</p>`
      : `<p class="muted">${tr.e("notif.no_email")}</p>`;
  return page(
    l,
    `<main class="narrow">
      <h1>${tr.e("notif.title")}</h1>
      ${input.saved ? `<p class="plus" role="status">${tr.e("common.saved")}</p>` : ""}
      ${where}
      <form method="post" action="/notifications" class="stack">
        <input type="hidden" name="_csrf" value="${esc(l.csrf ?? "")}">
        <fieldset>
          <legend>${tr.e("notif.replies_legend")}</legend>
          ${radio("instant", tr("notif.instant_hint"))}
          ${radio("daily", tr("notif.daily_hint", { time: input.digestTime }))}
          ${radio("never")}
        </fieldset>
        <label class="check"><input type="checkbox" name="versions" value="1"${input.versions ? " checked" : ""}> ${tr.e("notif.versions")}</label>
        <button type="submit">${tr.e("common.save")}</button>
      </form>
      ${
        input.documents.length > 1
          ? `<p class="muted small">${tr.e("notif.applies_to")}</p><ul>${input.documents.map((d) => `<li><a href="/d/${esc(d.document.slug)}">${esc(d.document.title)}</a>${d.role ? ` · ${esc(d.role)}` : ""}</li>`).join("")}</ul>`
          : ""
      }
      <p class="muted small">${tr.e("notif.no_secret")}</p>
      <p><a href="/">${tr.e("common.back_home")}</a></p>
    </main>`,
  );
}
