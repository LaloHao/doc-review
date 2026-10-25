// The page shell. Every interpolated value goes through `esc` (or a
// translator's `e`/`html`, which escape too). No inline scripts or styles: the
// CSP only allows 'self'. A page's script gets its messages from a JSON block
// (not executed, so the CSP doesn't apply to it).

import { clientMessages, type Tr } from "../../i18n/index.js";
import { esc } from "../../text.js";

export interface Layout {
  tr: Tr;
  title: string;
  who?: { kind: "owner" | "reviewer"; name: string } | null;
  csrf?: string;
  scripts?: string[];
  bodyClass?: string;
  data?: Record<string, string | number>;
  /** The document the page is about (shown in the navigation bar). */
  doc?: { slug: string; title: string } | null;
}

/** JSON inside <script type="application/json">: "<" can't close the element. */
export const jsonBlock = (id: string, v: unknown) =>
  `<script type="application/json" id="${esc(id)}">${JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}</script>`;

export function page(l: Layout, body: string): string {
  const tr = l.tr;
  const data = Object.entries(l.data ?? {})
    .map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`)
    .join("");
  const docLink = l.doc ? `<a class="doc-title" href="/d/${esc(l.doc.slug)}">${esc(l.doc.title)}</a>` : "";
  const nav = l.who
    ? `<nav class="top">
        <a class="brand" href="/">${tr.e("app.name")}</a>
        ${docLink}
        <span class="spacer"></span>
        ${l.who.kind === "owner" && l.doc ? `<a href="/d/${esc(l.doc.slug)}/manage" class="nav-link">${tr.e("nav.manage")}</a>` : ""}
        ${l.who.kind === "reviewer" ? `<a href="/notifications" class="nav-link">${tr.e("nav.notifications")}</a>` : ""}
        <span class="who">${esc(l.who.name)}${l.who.kind === "owner" ? ` · ${tr.e("nav.owner")}` : ""}</span>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="${esc(l.csrf ?? "")}">
          <button type="submit" class="link">${tr.e("nav.logout")}</button>
        </form>
      </nav>`
    : `<nav class="top"><span class="brand">${tr.e("app.name")}</span>${docLink}</nav>`;
  const scripts = l.scripts ?? [];
  return `<!doctype html>
<html lang="${esc(tr.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex, nofollow">
${l.csrf ? `<meta name="csrf-token" content="${esc(l.csrf)}">` : ""}
<title>${esc(l.title)}</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
${scripts.length ? jsonBlock("i18n", { lang: tr.lang, locale: tr.locale, messages: clientMessages(tr.lang) }) : ""}
${scripts.map((s) => `<script type="module" src="${esc(s)}"></script>`).join("\n")}
</head>
<body class="${esc(l.bodyClass ?? "")}"${data}>
${nav}
${body}
</body>
</html>`;
}

export function messagePage(tr: Tr, title: string, message: string, extra = ""): string {
  return page({ tr, title }, `<main class="narrow"><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main>`);
}
