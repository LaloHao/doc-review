// Shared helpers for the browser scripts. No inline handlers, no innerHTML with
// untrusted data: comment bodies arrive already rendered (escaped) by the server
// as `body_html`; everything else is set with textContent.

export const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";

export async function api(method, path, body) {
  const headers = { accept: "application/json", "x-csrf-token": csrf };
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
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data;
}

/** Creates an element: el("p", {class: "x", text: "hola"}, child, …). */
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

const dateFmt = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short" });
export const fmtDate = (s) => dateFmt.format(new Date(s));
