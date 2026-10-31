// Owner API client used by the CLI. The token is in ~/.config/doc-review/config.json
// ({"url": "...", "token": "..."}, optionally "servers": {"https://other": "token"}),
// which must not be readable by others (0600). A project may have a
// .doc-review.json ({"url"?, "document", "pdf", "progress", "sources"}) found
// upward from the working directory; its "url" only picks the server, and the
// token for it must be in config.json (a repository can't send your token
// elsewhere).

import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
    throw new Error(`invalid server URL (it must start with https://): ${url}`);
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) return url.replace(/\/+$/, "");
  throw new Error(`the server URL must use https:// (http only for localhost): ${url}`);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DOC_REVIEW_CONFIG) return env.DOC_REVIEW_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "doc-review", "config.json");
}

interface RawConfig {
  url?: unknown;
  token?: unknown;
  servers?: unknown;
}

/**
 * Reads the user's config and returns the server and token to use. `url`
 * (from a project file or --url) selects the server; its token must be in the
 * config file for that same origin.
 */
export async function loadClientConfig(path = configPath(), url?: string): Promise<ClientConfig> {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new Error(`${path} does not exist. Create it with {"url": "https://…", "token": "dr_owner_…"} and chmod 600.`);
  }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users: run chmod 600 ${path}`);
  }
  let raw: RawConfig;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const servers = new Map<string, string>();
  if (typeof raw.url === "string" && typeof raw.token === "string" && raw.url && raw.token) {
    servers.set(new URL(checkServerUrl(raw.url)).origin, raw.token);
  }
  if (raw.servers && typeof raw.servers === "object") {
    for (const [u, tok] of Object.entries(raw.servers as Record<string, unknown>)) {
      if (typeof tok === "string" && tok) servers.set(new URL(checkServerUrl(u)).origin, tok);
    }
  }
  const wanted = url ? checkServerUrl(url) : typeof raw.url === "string" && raw.url ? checkServerUrl(raw.url) : null;
  if (!wanted) throw new Error(`${path} must have "url" and "token".`);
  const token = servers.get(new URL(wanted).origin);
  if (!token) throw new Error(`no token for ${new URL(wanted).origin} in ${path} (add it under "servers")`);
  return { url: wanted, token };
}

/** .doc-review.json: a project's document and files. */
export interface ProjectConfig {
  root: string;
  url?: string;
  document?: string;
  /** A file, or files and globs (`*`, `?` in the file name): the newest match is published. */
  pdf?: string | string[];
  progress?: string | { command?: string; file?: string };
  sources?: string[];
}

export const PROJECT_FILE = ".doc-review.json";

/** Finds .doc-review.json in `dir` or above. */
export async function findProjectConfig(dir = process.cwd()): Promise<ProjectConfig | null> {
  let d = resolve(dir);
  for (;;) {
    const file = join(d, PROJECT_FILE);
    let text: string | null = null;
    try {
      text = await readFile(file, "utf8");
    } catch {
      /* not here */
    }
    if (text !== null) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`${file} is not valid JSON`);
      }
      const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
      const progress = raw.progress;
      return {
        root: d,
        url: s("url"),
        document: s("document"),
        pdf: Array.isArray(raw.pdf) ? raw.pdf.filter((x): x is string => typeof x === "string" && x !== "") : s("pdf"),
        progress:
          typeof progress === "string" || (progress && typeof progress === "object")
            ? (progress as ProjectConfig["progress"])
            : undefined,
        sources: Array.isArray(raw.sources) ? raw.sources.filter((x): x is string => typeof x === "string") : undefined,
      };
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const globRe = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);

/**
 * The PDF to publish from a project's "pdf": a file, or a list of files and
 * globs (wildcards in the file name only, e.g. "build/tesis-parcial*.pdf"), of
 * which the most recently modified existing one wins. A single plain file is
 * returned even if it doesn't exist yet (the caller reports it); null when
 * nothing matches.
 */
export async function projectPdf(proj: ProjectConfig): Promise<string | null> {
  const patterns = proj.pdf === undefined ? [] : Array.isArray(proj.pdf) ? proj.pdf : [proj.pdf];
  const abs = (p: string) => (isAbsolute(p) ? p : join(proj.root, p));
  if (patterns.length === 1 && !/[*?]/.test(patterns[0]!)) return abs(patterns[0]!);
  let best: { path: string; mtime: number } | null = null;
  for (const pattern of patterns) {
    const full = abs(pattern);
    let files: string[];
    if (/[*?]/.test(basename(full))) {
      const re = globRe(basename(full));
      files = (await readdir(dirname(full)).catch(() => [] as string[])).filter((f) => re.test(f)).map((f) => join(dirname(full), f));
    } else files = [full];
    for (const f of files) {
      const st = await stat(f).catch(() => null);
      if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: f, mtime: st.mtimeMs };
    }
  }
  return best?.path ?? null;
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
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.token}`,
      accept: "application/json",
      // The CLI speaks English; the server's error messages too, then.
      "accept-language": "en",
    };
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

  json<T>(method: string, path: string, body: unknown) {
    return this.request<T>(method, path, JSON.stringify(body), "application/json");
  }

  async publish(doc: string, pdfPath: string, progress: { path: string } | { json: string } | null, note: string) {
    const form = new FormData();
    form.set("pdf", new Blob([await readFile(pdfPath)], { type: "application/pdf" }), basename(pdfPath));
    if (progress && "path" in progress) form.set("progress", new Blob([await readFile(progress.path)], { type: "application/json" }), basename(progress.path));
    else if (progress) form.set("progress", new Blob([progress.json], { type: "application/json" }), "progress.json");
    form.set("note", note);
    return this.request<{ version: { number: number; page_count: number }; url: string }>("POST", `/api/documents/${encodeURIComponent(doc)}/versions`, form);
  }

  threads(doc: string, query: { version?: string; status?: string }) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]);
    return this.request<{ threads: ThreadJson[] }>("GET", `/api/documents/${encodeURIComponent(doc)}/threads?${qs}`);
  }
}

export interface ThreadJson {
  id: number;
  document: string;
  version: number;
  page: number;
  quote: string;
  status: string;
  url: string;
  section: { id: string; title: string } | null;
  comments: { id: number; author: { name: string; role?: string }; body: string | null; created_at: string; deleted: boolean }[];
}

// --- enrolling this computer as an owner device ---

/** The config file's server and token, if it has them (any other keys are kept on rewrite). */
async function readRawConfig(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const hasServer = (raw: Record<string, unknown> | null) =>
  raw !== null && typeof raw.url === "string" && raw.url !== "" && typeof raw.token === "string" && raw.token !== "";

/**
 * Whether `path` may receive a new server and token: refused when it already
 * has some, unless `force`. Checked before enrolling, so a code isn't spent
 * on a token that can't be saved.
 */
export async function checkConfigWritable(path: string, force: boolean): Promise<void> {
  const raw = await readRawConfig(path);
  if (hasServer(raw) && !force) {
    throw new Error(`${path} already has a server and token (${String(raw!.url)}): use --force to replace them (the other keys are kept)`);
  }
}

/**
 * Writes `url` and `token` to the config file, mode 0600 (its directory 0700
 * when created). Other keys are kept; a previous server of another origin
 * moves under "servers" instead of being lost. Written to a temporary file
 * and renamed, so a failure never leaves half a file.
 */
export async function saveClientConfig(path: string, url: string, token: string): Promise<void> {
  const raw = (await readRawConfig(path)) ?? {};
  const out: Record<string, unknown> = { ...raw, url, token };
  if (hasServer(raw)) {
    let oldOrigin = "";
    try {
      oldOrigin = new URL(String(raw.url)).origin;
    } catch {
      /* not a URL: dropped */
    }
    if (oldOrigin && oldOrigin !== new URL(url).origin) {
      const servers = raw.servers && typeof raw.servers === "object" && !Array.isArray(raw.servers) ? (raw.servers as Record<string, unknown>) : {};
      out.servers = { ...servers, [oldOrigin]: raw.token };
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export interface Enrolled {
  token: string;
  name: string;
  url: string;
}

/**
 * Redeems a one-time enrollment code at `url` (https, or http on this
 * machine): the server creates an owner device and returns its token, once.
 */
export async function enrollDevice(url: string, code: string, name: string, fetchImpl: typeof fetch = fetch): Promise<Enrolled> {
  const base = checkServerUrl(url);
  const res = await fetchImpl(`${base}/api/devices/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "accept-language": "en" },
    body: JSON.stringify({ code, name }),
  });
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = data?.error;
    throw new ApiError(res.status, typeof msg === "string" ? cleanText(msg).slice(0, 500) : `HTTP ${res.status}`);
  }
  if (typeof data?.token !== "string" || !data.token.startsWith("dr_owner_")) throw new Error("the server sent no token");
  return { token: data.token, name: typeof data.name === "string" ? cleanText(data.name) : name, url: base };
}
