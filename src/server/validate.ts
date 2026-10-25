// Validation of untrusted input: path and query integers, JSON fields, text.
// Every failure is a 400 with a message for the user, never a database error.

import type { Rect, ReplyNotify } from "../repo.js";
import { REPLY_NOTIFY } from "../repo.js";
import { cleanText } from "../text.js";
import { HttpError } from "./http.js";

export const MAX_INT = 2_147_483_647; // Postgres integer

/** A numeric path or query parameter: a positive integer, else 400. */
export function toInt(s: string | undefined | null, field = "El identificador"): number {
  if (!s || !/^\d{1,10}$/.test(s) || Number(s) < 1 || Number(s) > MAX_INT) {
    throw new HttpError(400, `${field} debe ser un entero positivo.`);
  }
  return Number(s);
}

/** A numeric JSON field: an integer in [min, max], else 400. */
export function intField(v: unknown, field: string, min = 1, max = MAX_INT): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return v;
}

/** Untrusted text: control and bidi characters removed, trimmed, bounded. */
export function str(v: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, `Falta ${field}.`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} debe ser texto.`);
  const s = cleanText(v).trim();
  if (opts.required && s === "") throw new HttpError(400, `Falta ${field}.`);
  if (s.length > max) throw new HttpError(400, `${field} es demasiado largo (máx. ${max}).`);
  return s;
}

export function parseRects(v: unknown): Rect[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 50) throw new HttpError(400, "rects debe tener de 1 a 50 rectángulos.");
  return v.map((r) => {
    if (typeof r !== "object" || r === null) throw new HttpError(400, "rect no válido.");
    const o = r as Record<string, unknown>;
    const n = (k: string) => {
      const x = o[k];
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) throw new HttpError(400, `rect.${k} debe estar entre 0 y 1.`);
      return Math.round(x * 1e5) / 1e5;
    };
    return { x: n("x"), y: n("y"), w: n("w"), h: n("h") };
  });
}

export function replyNotify(v: unknown): ReplyNotify {
  if (!REPLY_NOTIFY.includes(v as ReplyNotify)) throw new HttpError(400, "notify_replies: instant, daily o never.");
  return v as ReplyNotify;
}

export function isEmail(s: string): boolean {
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s) && s.length <= 320;
}

export function emailField(v: unknown): string | null {
  const e = str(v, "El correo", 320);
  if (e && !isEmail(e)) throw new HttpError(400, "El correo no es válido.");
  return e || null;
}
