// Shared helpers for the browser scripts. No inline handlers, no innerHTML with
// untrusted data: comment bodies arrive already rendered (escaped) by the server
// as `body_html`; everything else is set with textContent. The page's messages
// come from its JSON block (#i18n), in the page's language.

import { formatMessage } from "/static/i18n-format.js";

export const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";

const I18N = (() => {
  try {
    return JSON.parse(document.getElementById("i18n")?.textContent ?? "{}");
  } catch {
    return {};
  }
})();
export const LANG = I18N.lang ?? document.documentElement.lang ?? "en";
export const LOCALE = I18N.locale ?? "en-US";
const MESSAGES = I18N.messages ?? {};

/** A message of the page's language: t("js.reply"), t("js.page_n", {n: 3}). */
export function t(key, params = {}) {
  const m = MESSAGES[key];
  return m === undefined ? key : formatMessage(m, params, LOCALE);
}

export async function api(method, path, body) {
  // Error messages come back in the page's language.
  const headers = { accept: "application/json", "accept-language": LANG, "x-csrf-token": csrf };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error ?? t("js.error_status", { status: res.status }));
  return data;
}

/** Creates an element: el("p", {class: "x", text: "hello"}, child, …). */
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v; // only for server-rendered, escaped body_html
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const dateFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });
export const fmtDate = (s) => dateFmt.format(new Date(s));
