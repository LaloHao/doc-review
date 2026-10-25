import type { IncomingMessage, ServerResponse } from "node:http";
import { t, type Lang, type MsgKey } from "../i18n/index.js";

/** A parameter of an error message: text, a number, or another message (a field name). */
export type ErrParam = string | number | { key: MsgKey };

/** An error for the client: a status and a message key, translated when sent. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly key: MsgKey,
    readonly params: Record<string, ErrParam> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(key);
  }

  text(lang: Lang): string {
    const p: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(this.params)) p[k] = typeof v === "object" ? t(lang, v.key) : v;
    return t(lang, this.key, p);
  }
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) throw new HttpError(413, "err.too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, "err.too_large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "err.expected_json");
  const buf = await readBody(req, limit);
  try {
    const v: unknown = JSON.parse(buf.toString("utf8") || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "err.invalid_json");
  }
}

/** Parses an urlencoded form body. */
export async function readForm(req: IncomingMessage, limit = 16 * 1024): Promise<URLSearchParams> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) throw new HttpError(415, "err.invalid_form");
  return new URLSearchParams((await readBody(req, limit)).toString("utf8"));
}

/** Parses multipart/form-data with the platform's own parser (undici's Request). */
export async function readMultipart(req: IncomingMessage, limit: number): Promise<FormData> {
  const type = req.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\b/i.test(type)) throw new HttpError(415, "err.expected_multipart");
  const body = await readBody(req, limit);
  try {
    // The Buffer is handed over as is (no extra copy of a 50 MB upload).
    return await new Request("http://local/", { method: "POST", headers: { "content-type": type }, body: body as Uint8Array<ArrayBuffer> }).formData();
  } catch {
    throw new HttpError(400, "err.invalid_multipart");
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSec: number, opts: { httpOnly?: boolean } = {}): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "Secure",
    "SameSite=Lax",
    opts.httpOnly === false ? null : "HttpOnly",
  ]
    .filter(Boolean)
    .join("; ");
}

export function send(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  type: string,
  headers: Record<string, string | string[]> = {},
): void {
  res.statusCode = status;
  res.setHeader("content-type", type);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8", headers);
}

export function html(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  send(res, status, body, "text/html; charset=utf-8", headers);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.statusCode = 303;
  res.setHeader("location", location);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end();
}
