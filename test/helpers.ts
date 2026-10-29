import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import type { Mail } from "../src/notify/notify.js";
import { sha256Hex } from "../src/server/crypto.js";
import { startServer, type Running } from "../src/server/main.js";
import { sampleProgress, sampleThesis } from "./fixtures/make-pdf.mjs";

export const OWNER_TOKEN = "dr_owner_test-token-0123456789abcdefghijklmnopqrstuvwxyz";
export const ORIGIN = "https://review.example.test";

export interface TestServer extends Running {
  mails: Mail[];
  telegrams: string[];
  logs: string[];
  dir: string;
  stop(): Promise<void>;
  /** Owner request with the bearer token. */
  owner(path: string, init?: RequestInit): Promise<Response>;
  ownerJson(method: string, path: string, body?: unknown): Promise<Response>;
  /** Creates a document; returns its slug. */
  createDoc(slug: string, extra?: Record<string, unknown>): Promise<string>;
  publish(slug: string, pdf?: Uint8Array, progress?: unknown, note?: string): Promise<Response>;
  /** Invites someone (new: {name, email}; existing: {person_id}); returns the link and ids. */
  invite(slug: string, body: Record<string, unknown>): Promise<{ link: string; invitationId: number; personId: number }>;
  /** A browser that opened `link`. */
  browser(link?: string): Promise<Browser>;
}

/** A browser: keeps the session cookie, sends Origin and the CSRF token like the page scripts. */
export class Browser {
  cookie = "";
  csrf = "";
  constructor(private readonly base: string) {}

  async get(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, { redirect: "manual", headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers } });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      if (pair!.startsWith("__Host-dr_session=")) this.cookie = pair!.endsWith("=") ? "" : pair!;
    }
    return res;
  }

  async open(link: string) {
    const res = await this.get(new URL(link).pathname);
    await this.login();
    return res;
  }

  async login() {
    const me = await this.get("/api/me");
    if (me.ok) this.csrf = ((await me.json()) as { csrf: string }).csrf;
  }

  send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return fetch(this.base + path, {
      method,
      redirect: "manual",
      headers: {
        cookie: this.cookie,
        origin: ORIGIN,
        "x-csrf-token": this.csrf,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async json<T = Record<string, unknown>>(path: string): Promise<T> {
    return (await (await this.get(path)).json()) as T;
  }
}

export function publishForm(pdf: Uint8Array, progress: unknown, note = "", field = "progress") {
  const f = new FormData();
  f.set("pdf", new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), "document.pdf");
  if (progress !== null && progress !== undefined) f.set(field, new Blob([JSON.stringify(progress)], { type: "application/json" }), `${field}.json`);
  f.set("note", note);
  return f;
}

/** A real HTTP server on an ephemeral port, in-memory Postgres (PGlite), temp dir storage, fake notifiers. */
export async function startTestServer(env: Record<string, string> = {}, opts: { mail?: boolean } = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "doc-review-"));
  const mails: Mail[] = [];
  const telegrams: string[] = [];
  const logs: string[] = [];
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    PUBLIC_URL: ORIGIN,
    DATABASE_URL: "pglite:memory",
    STORAGE_TYPE: "fs",
    STORAGE_DIR: join(dir, "files"),
    OWNER_TOKEN_SHA256: sha256Hex(OWNER_TOKEN),
    OWNER_NAME: "Eduardo Ejemplo",
    EMAIL_OWNER_TO: "owner@example.test",
    ...env,
  });
  const running = await startServer(config, {
    mailer: opts.mail === false ? null : { send: async (m) => void mails.push(m) },
    telegram: { send: async (t) => void telegrams.push(t) },
    log: (m) => void logs.push(m),
  });
  const owner = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...(init.headers ?? {}) } });
  const ownerJson = (method: string, path: string, body?: unknown) =>
    owner(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } });
  return {
    ...running,
    mails,
    telegrams,
    logs,
    dir,
    owner,
    ownerJson,
    async createDoc(slug, extra = {}) {
      const res = await ownerJson("POST", "/api/documents", { slug, title: `Document ${slug}`, ...extra });
      if (res.status !== 201) throw new Error(`createDoc ${slug}: ${res.status} ${await res.text()}`);
      return slug;
    },
    publish(slug, pdf = sampleThesis(), progress = sampleProgress(), note = "") {
      return owner(`/api/documents/${slug}/versions`, { method: "POST", body: publishForm(pdf, progress, note) });
    },
    async invite(slug, body) {
      const res = await ownerJson("POST", `/api/documents/${slug}/invitations`, body);
      if (res.status !== 201) throw new Error(`invite: ${res.status} ${await res.text()}`);
      const r = (await res.json()) as { link: string; invitation: { id: number; person: { id: number } } };
      return { link: r.link, invitationId: r.invitation.id, personId: r.invitation.person.id };
    },
    async browser(link) {
      const b = new Browser(running.url);
      if (link) await b.open(link);
      return b;
    },
    async stop() {
      await running.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Waits for setImmediate-scheduled notifications. */
export const settle = () => new Promise((r) => setTimeout(r, 50));
