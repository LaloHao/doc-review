// Owner API client used by the CLI. Reads ~/.config/doc-review/config.json
// ({"url": "...", "token": "..."}), which must not be readable by others (0600).

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cleanText } from "./text.js";

export interface ClientConfig {
  url: string;
  token: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The server URL must be https (the owner token travels in every request);
 * plain http only for a server on this machine.
 */
export function checkServerUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL del servidor no válida (debe empezar con https://): ${url}`);
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) return url.replace(/\/+$/, "");
  throw new Error(`La URL del servidor debe usar https:// (http solo para localhost): ${url}`);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DOC_REVIEW_CONFIG) return env.DOC_REVIEW_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "doc-review", "config.json");
}

export async function loadClientConfig(path = configPath()): Promise<ClientConfig> {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new Error(`No existe ${path}. Créalo con {"url": "https://…", "token": "dr_owner_…"} y chmod 600.`);
  }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(`${path} es legible por otros usuarios: ejecuta chmod 600 ${path}`);
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<ClientConfig>;
  if (typeof raw.url !== "string" || typeof raw.token !== "string" || !raw.url || !raw.token) {
    throw new Error(`${path} debe tener "url" y "token".`);
  }
  return { url: checkServerUrl(raw.url), token: raw.token };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Client {
  private readonly cfg: ClientConfig;

  constructor(
    cfg: ClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.cfg = { ...cfg, url: checkServerUrl(cfg.url) };
  }

  async request<T>(method: string, path: string, body?: BodyInit, type?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.token}`, accept: "application/json" };
    if (type) headers["content-type"] = type;
    const res = await this.fetchImpl(this.cfg.url + path, { method, headers, body });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof msg === "string" ? cleanText(msg).slice(0, 500) : `HTTP ${res.status}`);
    }
    return data as T;
  }

  async publish(pdfPath: string, progressPath: string | null, note: string) {
    const form = new FormData();
    form.set("pdf", new Blob([await readFile(pdfPath)], { type: "application/pdf" }), basename(pdfPath));
    if (progressPath) form.set("progress", new Blob([await readFile(progressPath)], { type: "application/json" }), basename(progressPath));
    form.set("note", note);
    return this.request<{ version: { number: number; page_count: number }; url: string }>("POST", "/api/versions", form);
  }

  threads(query: { version?: string; status?: string }) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]);
    return this.request<{ threads: ThreadJson[] }>("GET", `/api/threads?${qs}`);
  }

  json<T>(method: string, path: string, body: unknown) {
    return this.request<T>(method, path, JSON.stringify(body), "application/json");
  }
}

export interface ThreadJson {
  id: number;
  version: number;
  page: number;
  quote: string;
  status: string;
  url: string;
  section: { id: string; title: string } | null;
  comments: { id: number; author: { name: string }; body: string | null; created_at: string; deleted: boolean }[];
}
