// Drives the running app in Chromium (playwright-core) like a director and the
// owner would, and saves screenshots to docs/images. Not part of `pnpm test`.
//
//   BASE=http://localhost:8099 DIRECTOR_LINK=… OWNER_TOKEN=… CHROME=/path/to/chrome \
//     node scripts/screenshots.mjs
//
// Fails if the page logs an error (for example a CSP violation).

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const { BASE, DIRECTOR_LINK, OWNER_TOKEN, CHROME } = process.env;
if (!BASE || !DIRECTOR_LINK || !OWNER_TOKEN) {
  console.error("BASE, DIRECTOR_LINK and OWNER_TOKEN are required");
  process.exit(2);
}
const out = new URL("../docs/images/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME || undefined, headless: true });
const errors = [];
const watch = (page) => {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
};

// --- director ---
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-MX" });
const d = await dctx.newPage();
watch(d);
await d.goto(DIRECTOR_LINK);
if (d.url().includes("/acceso/")) throw new Error("the secret link stayed in the URL");
await d.waitForSelector("body[data-ready='1']");
await d.evaluate(() => document.querySelector(".page[data-page='3']").scrollIntoView());
await d.waitForSelector(".page[data-page='3'] .textLayer span", { state: "attached", timeout: 10_000 }).catch((e) => {
  console.error(errors.join("\n"));
  throw e;
});

// Select a sentence of page 3 in the text layer and comment on it.
await d.evaluate(() => {
  const spans = [...document.querySelectorAll(".page[data-page='3'] .textLayer span")];
  const start = spans.findIndex((s) => s.textContent.includes("revisión"));
  const first = spans[start].firstChild;
  const end = spans.findIndex((s, i) => i > start && s.textContent.includes("producción"));
  const last = spans[end].firstChild;
  const range = document.createRange();
  range.setStart(first, first.textContent.indexOf("sin una"));
  range.setEnd(last, last.textContent.indexOf("producción") + "producción".length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.querySelector(".page[data-page='3']").scrollIntoView();
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await d.waitForSelector("#selection-button:not([hidden])");
await d.screenshot({ path: out + "01-seleccion.png" });
await d.click("#selection-button");
await d.fill("#composer-form textarea", "Sugiero respaldar esta afirmación con una **fuente** reciente (p. ej. un reporte de incidentes de 2025).");
await d.screenshot({ path: out + "02-comentario.png" });
await d.click("#composer-form button[type=submit]");
await d.waitForSelector(".thread");

// A point comment on page 4.
await d.click("#point-mode");
const p4 = await d.$(".page[data-page='4']");
await p4.scrollIntoViewIfNeeded();
const box = await p4.boundingBox();
await d.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
await d.fill("#composer-form textarea", "Aquí convendría una figura que resuma el proceso de anonimización.");
await d.click("#composer-form button[type=submit]");
await d.waitForFunction(() => document.querySelectorAll(".thread").length >= 2);
await d.evaluate(() => document.querySelector(".page[data-page='3']").scrollIntoView());
await d.waitForTimeout(300);
await d.screenshot({ path: out + "03-visor-director.png" });

// --- owner ---
const octx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-MX" });
const o = await octx.newPage();
watch(o);
await o.goto(BASE + "/entrar");
await o.fill("input[name=token]", OWNER_TOKEN);
await o.click("button[type=submit]");
await o.waitForSelector("text=Tu tesis");
await o.screenshot({ path: out + "04-panel-autor.png", fullPage: true });
const last = await o.evaluate(() => document.querySelector("table a[href^='/v/']")?.getAttribute("href"));
await o.goto(BASE + last);
await o.waitForSelector(".thread");
await o.fill(".thread .reply textarea", "Gracias, doctor. Agrego la referencia en la siguiente versión.");
await o.click(".thread .reply button");
await o.waitForFunction(() => document.querySelectorAll(".thread .comment").length >= 3);
await o.screenshot({ path: out + "05-visor-autor.png" });
if (last !== "/v/1") {
  await o.goto(`${BASE}${last}/cambios`);
  await o.evaluate(() => document.querySelectorAll("details").forEach((x) => (x.open = true)));
  await o.screenshot({ path: out + "06-cambios.png", fullPage: true });
}

// --- phone ---
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const m = await mctx.newPage();
watch(m);
await m.goto(DIRECTOR_LINK.replace(/\/acceso\/.*/, "/"));
await m.screenshot({ path: out + "07-sin-sesion-movil.png" });

await browser.close();
if (errors.length) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("screenshots in " + out);
