// Validation of untrusted input: path and query integers, JSON fields, text.
// Every failure is a 400 with a translated message, never a database error.

import { isLang, type Lang, type MsgKey } from "../i18n/index.js";
import { REPLY_NOTIFY, VISIBILITIES, type Rect, type ReplyNotify, type Visibility } from "../repo.js";
import { cleanText } from "../text.js";
import { HttpError } from "./http.js";

export const MAX_INT = 2_147_483_647; // Postgres integer

/** A numeric path or query parameter: a positive integer, else 400. */
export function toInt(s: string | undefined | null, field: MsgKey = "field.id"): number {
  if (!s || !/^\d{1,10}$/.test(s) || Number(s) < 1 || Number(s) > MAX_INT) {
    throw new HttpError(400, "err.positive_int", { field: { key: field } });
  }
  return Number(s);
}

/** A numeric JSON field: an integer in [min, max], else 400. */
export function intField(v: unknown, field: MsgKey, min = 1, max = MAX_INT): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, "err.int_range", { field: { key: field }, min, max });
  }
  return v;
}

/** Untrusted text: control and bidi characters removed, trimmed, bounded. */
export function str(v: unknown, field: MsgKey, max: number, opts: { required?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, "err.required", { field: { key: field } });
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, "err.not_text", { field: { key: field } });
  const s = cleanText(v).trim();
  if (opts.required && s === "") throw new HttpError(400, "err.required", { field: { key: field } });
  if (s.length > max) throw new HttpError(400, "err.too_long", { field: { key: field }, max });
  return s;
}

/** One line of text (names, titles, roles): newlines and tabs become spaces. */
export function line(v: unknown, field: MsgKey, max: number, opts: { required?: boolean } = {}): string {
  return str(typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ") : v, field, max, opts);
}

export function parseRects(v: unknown): Rect[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 50) throw new HttpError(400, "err.rects");
  return v.map((r) => {
    if (typeof r !== "object" || r === null) throw new HttpError(400, "err.rect");
    const o = r as Record<string, unknown>;
    const n = (k: string) => {
      const x = o[k];
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) throw new HttpError(400, "err.rect_range", { field: k });
      return Math.round(x * 1e5) / 1e5;
    };
    return { x: n("x"), y: n("y"), w: n("w"), h: n("h") };
  });
}

export function replyNotify(v: unknown): ReplyNotify {
  if (!REPLY_NOTIFY.includes(v as ReplyNotify)) throw new HttpError(400, "err.notify_replies");
  return v as ReplyNotify;
}

export function visibility(v: unknown): Visibility {
  if (!VISIBILITIES.includes(v as Visibility)) throw new HttpError(400, "err.visibility");
  return v as Visibility;
}

export function language(v: unknown): Lang {
  if (!isLang(v)) throw new HttpError(400, "err.language");
  return v;
}

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function slug(v: unknown): string {
  if (typeof v !== "string" || !SLUG_RE.test(v)) throw new HttpError(400, "err.slug");
  return v;
}

export function isEmail(s: string): boolean {
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s) && s.length <= 320;
}

export function emailField(v: unknown): string | null {
  const e = str(v, "field.email", 320);
  if (e && !isEmail(e)) throw new HttpError(400, "err.email");
  return e || null;
}
