// PDF viewer with comments. pdf.js renders each page (canvas + text layer); text
// selected in the text layer, or a clicked point, becomes a comment thread anchored
// to its page with rectangles normalized to the page size (0..1), so highlights
// land in the same place at any zoom.

import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
import { api, el, fmtDate } from "/static/common.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const body = document.body;
const VERSION = Number(body.dataset.version);
const ROLE = body.dataset.role;
const pagesEl = document.getElementById("pages");
const listEl = document.getElementById("thread-list");
const composer = document.getElementById("composer");
const composerForm = document.getElementById("composer-form");
const composerQuote = document.getElementById("composer-quote");
const selButton = document.getElementById("selection-button");
const pointBtn = document.getElementById("point-mode");
const showResolved = document.getElementById("show-resolved");

let doc = null;
let scale = 1;
let baseWidth = 612;
let views = [];
let threads = [];
let pointMode = false;
let pending = null; // anchor being composed
let observer = null;

// --- layout and rendering ---

function fitScale() {
  const w = pagesEl.clientWidth - 32;
  return Math.max(0.5, Math.min(1.5, w / baseWidth));
}

function layout() {
  pagesEl.replaceChildren();
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) renderPage(views[Number(e.target.dataset.page) - 1]);
    },
    { root: null, rootMargin: "600px 0px" },
  );
  views = views.map((v) => {
    const vp = v.base.clone({ scale });
    const div = el("div", { class: "page", "data-page": v.n, "aria-label": `Página ${v.n}` });
    div.style.width = `${vp.width}px`;
    div.style.height = `${vp.height}px`;
    div.style.setProperty("--scale-factor", String(scale));
    const label = el("div", { class: "page-number", text: String(v.n) });
    const hl = el("div", { class: "hl-layer" });
    const pins = el("div", { class: "pin-layer" });
    div.append(label, hl, pins);
    pagesEl.append(div);
    observer.observe(div);
    div.addEventListener("click", (ev) => onPageClick(ev, v.n, div));
    return { ...v, div, hl, pins, viewport: vp, rendered: false };
  });
  drawHighlights();
}

async function renderPage(v) {
  if (!v || v.rendered) return;
  v.rendered = true;
  const page = await doc.getPage(v.n);
  const ratio = window.devicePixelRatio || 1;
  const canvas = el("canvas", { class: "page-canvas" });
  canvas.width = Math.floor(v.viewport.width * ratio);
  canvas.height = Math.floor(v.viewport.height * ratio);
  canvas.style.width = `${v.viewport.width}px`;
  canvas.style.height = `${v.viewport.height}px`;
  const textDiv = el("div", { class: "textLayer" });
  v.div.prepend(canvas);
  v.div.insertBefore(textDiv, v.pins);
  await page.render({
    canvas,
    canvasContext: canvas.getContext("2d"),
    viewport: v.viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
  }).promise;
  const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: v.viewport });
  await tl.render();
}

function visibleThreads() {
  return threads.filter((t) => showResolved.checked || t.status === "open");
}

function drawHighlights() {
  for (const v of views) {
    v.hl?.replaceChildren();
    v.pins?.replaceChildren();
  }
  for (const t of visibleThreads()) {
    const v = views[t.page - 1];
    if (!v?.hl) continue;
    const cls = `hl ${t.status === "resolved" ? "hl-resolved" : ""}`;
    if (t.anchor === "point") {
      const r = t.rects[0];
      const pin = el("button", { class: `pin ${t.status === "resolved" ? "hl-resolved" : ""}`, type: "button", title: excerpt(t), "aria-label": `Comentario ${t.id}` });
      pin.style.left = `${r.x * 100}%`;
      pin.style.top = `${r.y * 100}%`;
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        focusThread(t.id);
      });
      v.pins.append(pin);
      continue;
    }
    for (const r of t.rects) {
      const box = el("div", { class: cls, title: excerpt(t), "data-thread": t.id });
      box.style.left = `${r.x * 100}%`;
      box.style.top = `${r.y * 100}%`;
      box.style.width = `${r.w * 100}%`;
      box.style.height = `${r.h * 100}%`;
      v.hl.append(box);
    }
  }
}

function excerpt(t) {
  const c = t.comments.find((x) => !x.deleted);
  const s = `${t.author.name}: ${c?.body ?? ""}`;
  return s.length > 140 ? s.slice(0, 139) + "…" : s;
}

// --- selection and point comments ---

function pageOf(node) {
  const e = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return e?.closest(".page") ?? null;
}

function selectionAnchor() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const pageDiv = pageOf(range.startContainer);
  if (!pageDiv || !pagesEl.contains(pageDiv)) return null;
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (!quote) return null;
  const box = pageDiv.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1 && r.bottom > box.top && r.top < box.bottom)
    .map((r) => ({
      x: clamp((r.left - box.left) / box.width),
      y: clamp((r.top - box.top) / box.height),
      w: clamp(r.width / box.width),
      h: clamp(r.height / box.height),
    }))
    .slice(0, 50);
  if (rects.length === 0) return null;
  return { anchor: "text", page: Number(pageDiv.dataset.page), quote: quote.slice(0, 2000), rects: mergeRects(rects), last: range.getClientRects() };
}

const clamp = (n) => Math.max(0, Math.min(1, Math.round(n * 1e5) / 1e5));

/** Merges the many per-span rectangles of a line into one per line. */
function mergeRects(rects) {
  const out = [];
  for (const r of rects.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.y - r.y) < 0.004 && r.x <= prev.x + prev.w + 0.02) {
      const right = Math.max(prev.x + prev.w, r.x + r.w);
      prev.h = Math.max(prev.h, r.h);
      prev.w = right - prev.x;
    } else out.push({ ...r });
  }
  return out;
}

document.addEventListener("mouseup", () => setTimeout(updateSelectionButton, 0));
document.addEventListener("keyup", (e) => {
  if (e.shiftKey) updateSelectionButton();
});

function updateSelectionButton() {
  if (!composer.hidden) return;
  const a = selectionAnchor();
  if (!a) {
    selButton.hidden = true;
    return;
  }
  const last = a.last[a.last.length - 1];
  selButton.hidden = false;
  selButton.style.left = `${Math.min(window.innerWidth - 180, last.right + window.scrollX + 6)}px`;
  selButton.style.top = `${last.bottom + window.scrollY + 6}px`;
  selButton.onclick = () => {
    selButton.hidden = true;
    openComposer(a);
  };
}

pointBtn.addEventListener("click", () => {
  pointMode = !pointMode;
  pointBtn.setAttribute("aria-pressed", String(pointMode));
  body.classList.toggle("point-mode", pointMode);
});

function onPageClick(ev, n, div) {
  const box = div.getBoundingClientRect();
  if (!pointMode) {
    // Highlights sit under the text layer (so text stays selectable): hit-test here.
    if (!window.getSelection()?.isCollapsed) return;
    const x = (ev.clientX - box.left) / box.width;
    const y = (ev.clientY - box.top) / box.height;
    const hit = visibleThreads().find(
      (t) => t.page === n && t.anchor === "text" && t.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h),
    );
    if (hit) focusThread(hit.id);
    return;
  }
  pointMode = false;
  pointBtn.setAttribute("aria-pressed", "false");
  body.classList.remove("point-mode");
  openComposer({
    anchor: "point",
    page: n,
    quote: "",
    rects: [{ x: clamp((ev.clientX - box.left) / box.width), y: clamp((ev.clientY - box.top) / box.height), w: 0, h: 0 }],
  });
}

function openComposer(a) {
  pending = a;
  composerQuote.textContent = a.anchor === "text" ? `«${a.quote.length > 300 ? a.quote.slice(0, 299) + "…" : a.quote}» (página ${a.page})` : `Punto en la página ${a.page}`;
  composer.hidden = false;
  composerForm.elements.body.value = "";
  composerForm.elements.body.focus();
}

document.getElementById("composer-cancel").addEventListener("click", () => {
  composer.hidden = true;
  pending = null;
});

composerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pending) return;
  const btn = composerForm.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const { last, ...anchor } = pending;
    const { thread } = await api("POST", "/api/threads", { version: VERSION, ...anchor, body: composerForm.elements.body.value });
    threads.push(thread);
    threads.sort((a, b) => a.page - b.page || a.id - b.id);
    composer.hidden = true;
    pending = null;
    window.getSelection()?.removeAllRanges();
    renderThreads();
    drawHighlights();
    focusThread(thread.id);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// --- threads sidebar ---

function author(c) {
  return el("span", { class: "author" }, c.author.name, c.author.kind === "owner" ? el("span", { class: "tag tag-owner", text: "autor" }) : null);
}

function commentNode(t, c) {
  const node = el(
    "div",
    { class: `comment ${c.deleted ? "deleted" : ""}`, id: `comentario-${c.id}` },
    el("div", { class: "comment-head" }, author(c), el("time", { datetime: c.created_at, text: fmtDate(c.created_at) }), c.edited_at ? el("span", { class: "muted small", text: "(editado)" }) : null),
    el("div", { class: "comment-body", html: c.body_html }),
  );
  if (c.mine && !c.deleted) {
    const actions = el(
      "div",
      { class: "comment-actions" },
      el("button", { type: "button", class: "link", text: "Editar", onclick: () => editComment(node, t, c) }),
      el("button", {
        type: "button",
        class: "link danger",
        text: "Eliminar",
        onclick: async () => {
          if (!confirm("¿Eliminar este comentario?")) return;
          await mutate(() => api("DELETE", `/api/comments/${c.id}`));
        },
      }),
    );
    node.append(actions);
  }
  return node;
}

function editComment(node, t, c) {
  const ta = el("textarea", { rows: 4, maxlength: 10000 });
  ta.value = c.body ?? "";
  const form = el(
    "form",
    { class: "stack" },
    ta,
    el("div", { class: "row" }, el("button", { type: "submit", text: "Guardar" }), el("button", { type: "button", class: "secondary", text: "Cancelar", onclick: () => renderThreads() })),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await mutate(() => api("PATCH", `/api/comments/${c.id}`, { body: ta.value }));
  });
  node.querySelector(".comment-body").replaceWith(form);
  node.querySelector(".comment-actions")?.remove();
  ta.focus();
}

async function mutate(fn) {
  try {
    const { thread } = await fn();
    threads = threads.map((t) => (t.id === thread.id ? thread : t));
    renderThreads();
    drawHighlights();
    focusThread(thread.id, false);
  } catch (err) {
    alert(err.message);
  }
}

function threadNode(t) {
  const reply = el("textarea", { rows: 1, maxlength: 10000, placeholder: "Responder…", "aria-label": "Respuesta" });
  const replyForm = el("form", { class: "reply" }, reply, el("button", { type: "submit", text: "Responder" }));
  replyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!reply.value.trim()) return;
    await mutate(() => api("POST", `/api/threads/${t.id}/comments`, { body: reply.value }));
  });
  const toggle = el("button", {
    type: "button",
    class: "secondary small-btn",
    text: t.status === "open" ? "Marcar resuelto" : "Reabrir",
    onclick: () => mutate(() => api("POST", `/api/threads/${t.id}/${t.status === "open" ? "resolve" : "reopen"}`)),
  });
  const node = el(
    "article",
    { class: `thread ${t.status}`, id: `hilo-${t.id}`, tabindex: "-1" },
    el(
      "header",
      {},
      el("button", { type: "button", class: "link page-link", text: `Página ${t.page}`, onclick: () => scrollToThread(t) }),
      t.chapter ? el("span", { class: "muted small", text: t.chapter.title }) : null,
      el("span", { class: `tag tag-${t.status === "open" ? "open" : "resolved"}`, text: t.status === "open" ? "Abierto" : "Resuelto" }),
    ),
    t.quote ? el("blockquote", { class: "quote", text: t.quote }) : el("p", { class: "muted small", text: "Comentario sobre un punto de la página." }),
    ...t.comments.map((c) => commentNode(t, c)),
    t.status === "resolved" && t.resolved_by ? el("p", { class: "muted small", text: `Resuelto por ${t.resolved_by}` }) : null,
    el("div", { class: "thread-actions" }, toggle),
    replyForm,
  );
  return node;
}

function renderThreads() {
  const list = visibleThreads();
  if (list.length === 0) {
    listEl.replaceChildren(el("p", { class: "muted", text: threads.length ? "No hay comentarios abiertos." : "Aún no hay comentarios en esta versión. Seleccione texto del PDF para comentar." }));
    return;
  }
  listEl.replaceChildren(...list.map(threadNode));
}

function focusThread(id, flash = true) {
  const node = document.getElementById(`hilo-${id}`);
  if (!node) return;
  node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (flash) {
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1500);
    node.focus({ preventScroll: true });
  }
}

function scrollToThread(t) {
  const v = views[t.page - 1];
  if (!v) return;
  const r = t.rects[0];
  const y = v.div.getBoundingClientRect().top + window.scrollY + (r ? r.y * v.div.clientHeight : 0) - 120;
  window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
}

// --- controls ---

document.getElementById("version-select").addEventListener("change", (e) => {
  location.href = `/v/${e.target.value}`;
});
showResolved.addEventListener("change", () => {
  renderThreads();
  drawHighlights();
});
document.getElementById("zoom-in").addEventListener("click", () => {
  scale = Math.min(3, scale * 1.2);
  layout();
});
document.getElementById("zoom-out").addEventListener("click", () => {
  scale = Math.max(0.4, scale / 1.2);
  layout();
});

// --- start ---

async function start() {
  const [{ threads: list }] = await Promise.all([
    api("GET", `/api/threads?version=${VERSION}&status=all`),
    (async () => {
      doc = await pdfjsLib.getDocument({
        url: `/api/versions/${VERSION}/pdf`,
        withCredentials: true,
        disableRange: true,
        disableStream: true,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
        iccUrl: "/vendor/pdfjs/iccs/",
      }).promise;
    })(),
  ]);
  threads = list;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push({ n, base: page.getViewport({ scale: 1 }) });
  }
  views = pages;
  baseWidth = pages[0]?.base.width ?? 612;
  scale = fitScale();
  layout();
  renderThreads();
  const m = /^#hilo-(\d+)$/.exec(location.hash);
  if (m) {
    const t = threads.find((x) => x.id === Number(m[1]));
    if (t) {
      if (t.status === "resolved") {
        showResolved.checked = true;
        renderThreads();
        drawHighlights();
      }
      scrollToThread(t);
      focusThread(t.id);
    }
  }
  body.dataset.ready = "1";
}

start().catch((err) => {
  console.error(err);
  pagesEl.replaceChildren(el("p", { class: "error", text: `No se pudo cargar el PDF: ${err.message}` }));
});

void ROLE;
