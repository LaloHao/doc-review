// Drives the running app in Chromium (playwright-core) as the reviewers and the
// owner would, and saves screenshots to docs/images (English, and one in
// Spanish). Not part of `pnpm test`; scripts/smoke.sh runs it with CHROME set.
//
//   BASE=http://localhost:8099 ANA_LINK=… LUIS_LINK=… OWNER_TOKEN=… CHROME=/path/to/chrome \
//     node scripts/screenshots.mjs
//
// ANA_LINK is Ana's link to the English report (she also reviews the thesis);
// LUIS_LINK is Luis's link to the Spanish thesis. Fails if a page logs an
// error (for example a CSP violation).

import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

const { BASE, ANA_LINK, LUIS_LINK, OWNER_TOKEN, CHROME } = process.env;
if (!BASE || !ANA_LINK || !LUIS_LINK || !OWNER_TOKEN) {
  console.error("BASE, ANA_LINK, LUIS_LINK and OWNER_TOKEN are required");
  process.exit(2);
}
const out = new URL("../docs/images/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".png")) rmSync(out + f);

const browser = await chromium.launch({ executablePath: CHROME || undefined, headless: true });
const errors = [];
const watch = (page) => {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
};
const desktop = (locale) => browser.newContext({ viewport: { width: 1440, height: 900 }, locale, extraHTTPHeaders: { "accept-language": locale } });

/** Selects the text of a page's text layer from `from` to the end of `to`. */
async function select(page, n, from, to) {
  await page.evaluate(
    ({ n, from, to }) => {
      const spans = [...document.querySelectorAll(`.page[data-page='${n}'] .textLayer span`)];
      const start = spans.findIndex((s) => s.textContent.includes(from));
      const end = spans.findIndex((s, i) => i >= start && s.textContent.includes(to));
      const a = spans[start].firstChild;
      const b = spans[end].firstChild;
      const range = document.createRange();
      range.setStart(a, a.textContent.indexOf(from));
      range.setEnd(b, b.textContent.indexOf(to) + to.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.querySelector(`.page[data-page='${n}']`).scrollIntoView();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { n, from, to },
  );
}

async function ready(page, n = 3) {
  await page.waitForSelector("body[data-ready='1']");
  await page.evaluate((n) => document.querySelector(`.page[data-page='${n}']`).scrollIntoView(), n);
  await page.waitForSelector(`.page[data-page='${n}'] .textLayer span`, { state: "attached", timeout: 10_000 }).catch((e) => {
    console.error(errors.join("\n"));
    throw e;
  });
}

// --- Ana, a reviewer of the English report (and of the thesis) ---
const jctx = await desktop("en-US");
const j = await jctx.newPage();
watch(j);
await j.goto(ANA_LINK);
if (j.url().includes("/a/")) throw new Error("the secret link stayed in the URL");
await ready(j);
await select(j, 3, "connection pool", "batch job");
await j.waitForSelector("#selection-button:not([hidden])");
await j.screenshot({ path: out + "01-selection.png" });
await j.click("#selection-button");
await j.fill("#composer-form textarea", "Was the pool size **reviewed** when the batch job was added? A link to the change would help.");
await j.screenshot({ path: out + "02-comment.png" });
await j.click("#composer-form button[type=submit]");
await j.waitForSelector(".thread");
await j.click("#point-mode");
const p5 = await j.$(".page[data-page='5']");
await p5.scrollIntoViewIfNeeded();
const box = await p5.boundingBox();
await j.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
await j.fill("#composer-form textarea", "Who owns each action, and by when?");
await j.click("#composer-form button[type=submit]");
await j.waitForFunction(() => document.querySelectorAll(".thread").length >= 2);
await j.evaluate(() => document.querySelector(".page[data-page='3']").scrollIntoView());
await j.waitForTimeout(300);
await j.screenshot({ path: out + "03-reviewer-viewer.png" });

await j.goto(BASE + "/");
await j.waitForSelector("text=These are the documents");
await j.screenshot({ path: out + "09-reviewer-documents.png" });
await j.click("nav a[href='/notifications']");
await j.waitForSelector("text=When someone replies");
await j.check("input[name=replies][value=daily]");
await j.click("form[action='/notifications'] button[type=submit]");
await j.waitForSelector("text=Saved.");
await j.screenshot({ path: out + "08-notifications.png" });

// --- the owner ---
const octx = await desktop("en-US");
const o = await octx.newPage();
watch(o);
await o.goto(BASE + "/login");
await o.fill("input[name=token]", OWNER_TOKEN);
await o.click("button[type=submit]");
await o.waitForSelector("h1:text('Documents')");
await o.screenshot({ path: out + "04-owner-dashboard.png", fullPage: true });
await o.goto(BASE + "/d/report/manage");
await o.waitForSelector("text=Reviewers");
await o.screenshot({ path: out + "05-document-manage.png", fullPage: true });
await o.goto(BASE + "/d/report/v/2");
await o.waitForSelector(".thread");
await o.fill(".thread .reply textarea", "Good point: it wasn't. I added the review of the pool size to the actions.");
await o.click(".thread .reply button");
await o.waitForFunction(() => document.querySelectorAll(".thread .comment").length >= 3);
await o.screenshot({ path: out + "06-owner-viewer.png" });
await o.goto(BASE + "/d/report/v/2/changes");
await o.evaluate(() => document.querySelectorAll("details").forEach((x) => (x.open = true)));
await o.screenshot({ path: out + "07-changes.png", fullPage: true });

// --- phone ---
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US" });
const m = await mctx.newPage();
watch(m);
await m.goto(ANA_LINK);
await ready(m);
await m.waitForTimeout(500);
await m.screenshot({ path: out + "10-phone.png" });

// --- Luis, a co-director of the Spanish thesis ---
const hctx = await desktop("es-MX");
const h = await hctx.newPage();
watch(h);
await h.goto(LUIS_LINK);
await h.goto(BASE + "/d/thesis/v/2");
await ready(h);
await select(h, 3, "sin una revisión", "operación");
await h.waitForSelector("#selection-button:not([hidden])");
await h.click("#selection-button");
await h.fill("#composer-form textarea", "Convendría citar aquí algún estudio reciente sobre rutas de transporte poco eficientes.");
await h.click("#composer-form button[type=submit]");
await h.waitForSelector(".thread");
await h.evaluate(() => document.querySelector(".page[data-page='3']").scrollIntoView());
await h.waitForTimeout(300);
await h.screenshot({ path: out + "es-01-visor-revisor.png" });

await browser.close();
if (errors.length) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("screenshots in " + out);
