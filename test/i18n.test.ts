// Both catalogs have every key, with the same placeholders; the browser's
// formatter is the server's; every message the pages and scripts use exists.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en.js";
import { es } from "../src/i18n/es.js";
import { formatMessage } from "../src/i18n/format.js";
import { CATALOGS, clientMessages, LANGS, negotiate, t, tHtml } from "../src/i18n/index.js";

/** Placeholder names of a message, plural selectors included. */
function placeholders(m: string): string[] {
  const names = new Set<string>();
  // "{name}" or "{n, plural, …}"; the text of a plural case ("one {is #}") is not one.
  for (const x of m.matchAll(/\{\s*(\w+)\s*[},]/g)) names.add(x[1]!);
  return [...names].sort();
}

async function sources(dir: string, ext: RegExp): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && ext.test(e.name)) out += await readFile(join(e.parentPath, e.name), "utf8");
  }
  return out;
}

describe("catalogs", () => {
  it("have the same keys in English and Spanish", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(CATALOGS[lang])) expect(v.trim(), `${lang} ${k}`).not.toBe("");
    }
  });

  it("use the same placeholders in both languages", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(es[k]), k).toEqual(placeholders(en[k]));
    }
  });

  it("have balanced braces", () => {
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(CATALOGS[lang])) {
        let depth = 0;
        for (const ch of v) {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
          expect(depth, `${lang} ${k}`).toBeGreaterThanOrEqual(0);
        }
        expect(depth, `${lang} ${k}`).toBe(0);
      }
    }
  });

  it("contain every key the browser scripts use", async () => {
    const js = await sources(join(import.meta.dirname, "../public"), /\.js$/);
    const used = [...js.matchAll(/\bt(?:r)?\(\s*"(js\.[a-z0-9_]+)"/g)].map((m) => m[1]!);
    // Keys picked with a condition: t(cond ? "js.a" : "js.b").
    used.push(...[...js.matchAll(/"(js\.[a-z0-9_]+)"/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(40);
    for (const k of new Set(used)) expect(Object.keys(en), k).toContain(k);
    expect(Object.keys(clientMessages("es")).every((k) => k.startsWith("js."))).toBe(true);
  });

  it("have no unused keys", async () => {
    const code = (await sources(join(import.meta.dirname, "../src"), /\.(ts|mjs)$/)) + (await sources(join(import.meta.dirname, "../public"), /\.js$/));
    const body = code.replace(/export const (en|es)[\s\S]*?\n\};?\n/g, "");
    const unused = Object.keys(en).filter((k) => !body.includes(`"${k}"`));
    expect(unused).toEqual([]);
  });
});

describe("formatting", () => {
  it("fills placeholders and plurals", () => {
    expect(t("en", "progress.words_n", { n: 1 })).toBe("1 word");
    expect(t("en", "progress.words_n", { n: 1234 })).toBe("1,234 words");
    expect(t("es", "progress.words_n", { n: 2 })).toBe("2 palabras");
    expect(t("es", "diff.words", { n: -3, signed: "−3" })).toBe("−3 palabras");
    expect(t("en", "diff.sentences", { added: 1, removed: 2 })).toBe("1 new sentence, 2 removed");
    expect(t("es", "err.required", { field: "El nombre" })).toBe("Falta El nombre.");
    expect(formatMessage("{missing} {x}", { x: 1 }, "en-US")).toBe("{missing} 1");
  });

  it("escapes HTML around trusted fragments", () => {
    expect(tHtml("en", "notif.goes_to", { email: "<strong>a&amp;b</strong>" })).toBe("Notifications go to <strong>a&amp;b</strong>.");
    expect(tHtml("en", "switch.heading", {}, { name: "<b>x</b>" })).toBe("Sign in as &lt;b&gt;x&lt;/b&gt;?");
  });

  it("the browser's formatter gives the same results", async () => {
    const browser = (await import("../public/i18n-format.js" as string)) as { formatMessage: typeof formatMessage };
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(CATALOGS[lang])) {
        const params = { n: 3, added: 1, removed: 0, name: "A", signed: "+3", pct: 50, pages: 1, max: 9 };
        expect(browser.formatMessage(v, params, "es-MX"), `${lang} ${k}`).toBe(formatMessage(v, params, "es-MX"));
      }
    }
  });

  it("negotiates the language from Accept-Language", () => {
    expect(negotiate(undefined)).toBe("en");
    expect(negotiate("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(negotiate("fr-FR, en;q=0.5, es;q=0.7")).toBe("es");
    expect(negotiate("de, *;q=0.1")).toBe("en");
    expect(negotiate("es;q=0, en")).toBe("en");
    expect(negotiate("ES")).toBe("es");
  });
});
