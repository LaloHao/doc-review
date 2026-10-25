// Translations. The UI, the API's error messages and the notifications are in
// English or Spanish: a document's language for everything about that
// document, the browser's Accept-Language elsewhere. Every key exists in both
// catalogs (the types and a test check it).

import { esc } from "../text.js";
import { en } from "./en.js";
import { es } from "./es.js";
import { formatMessage, type Params } from "./format.js";

export type { Params };
export type Lang = "en" | "es";
export const LANGS: readonly Lang[] = ["en", "es"];
export type MsgKey = keyof typeof en;
export type Catalog = Record<MsgKey, string>;

export const CATALOGS: Record<Lang, Catalog> = { en, es };

/** Locale used for numbers and dates. */
export const LOCALES: Record<Lang, string> = { en: "en-US", es: "es-MX" };

export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

export function t(lang: Lang, key: MsgKey, params: Params = {}): string {
  return formatMessage(CATALOGS[lang][key] ?? CATALOGS.en[key] ?? key, params, LOCALES[lang]);
}

/**
 * A message as HTML: the catalog text is escaped, and `html` params are
 * inserted as they are (the caller escapes what goes in them).
 */
export function tHtml(lang: Lang, key: MsgKey, html: Record<string, string> = {}, params: Params = {}): string {
  const tokens = new Map<string, string>();
  const p: Params = { ...params };
  Object.entries(html).forEach(([k, v], i) => {
    const tok = `\u0001${i}\u0001`;
    tokens.set(tok, v);
    p[k] = tok;
  });
  return esc(t(lang, key, p)).replace(/\u0001\d+\u0001/g, (tok) => tokens.get(tok) ?? "");
}

/** A translator bound to a language. */
export interface Tr {
  lang: Lang;
  locale: string;
  (key: MsgKey, params?: Params): string;
  /** Escaped for HTML. */
  e(key: MsgKey, params?: Params): string;
  html(key: MsgKey, html: Record<string, string>, params?: Params): string;
  num(n: number): string;
  date(d: Date | string, timeZone?: string): string;
}

export function translator(lang: Lang): Tr {
  const fn = ((key: MsgKey, params?: Params) => t(lang, key, params)) as Tr;
  fn.lang = lang;
  fn.locale = LOCALES[lang];
  fn.e = (key, params) => esc(t(lang, key, params));
  fn.html = (key, html, params) => tHtml(lang, key, html, params);
  fn.num = (n) => n.toLocaleString(LOCALES[lang]);
  fn.date = (d, timeZone) =>
    new Intl.DateTimeFormat(LOCALES[lang], {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone ?? (process.env.TZ || "America/Mexico_City"),
    }).format(new Date(d));
  return fn;
}

/** The preferred supported language of an Accept-Language header ("en" if none). */
export function negotiate(header: string | undefined | null, fallback: Lang = "en"): Lang {
  if (!header) return fallback;
  const prefs = header
    .split(",")
    .slice(0, 20)
    .map((part, i) => {
      const [tag = "", ...attrs] = part.trim().split(";");
      const q = attrs.map((a) => /^\s*q=([0-9.]+)\s*$/.exec(a)?.[1]).find(Boolean);
      return { lang: tag.trim().toLowerCase().split("-")[0] ?? "", q: q === undefined ? 1 : Number(q), i };
    })
    .filter((p) => p.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return prefs.map((p) => p.lang).find(isLang) ?? fallback;
}

/** Messages a page's script needs (keys starting with "js."), for the page's JSON block. */
export function clientMessages(lang: Lang): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(CATALOGS[lang])) if (k.startsWith("js.")) out[k] = v;
  return out;
}
