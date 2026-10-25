import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import type { Mail } from "../src/notify/notify.js";
import { sha256Hex } from "../src/server/crypto.js";
import { startServer, type Running } from "../src/server/main.js";

export const OWNER_TOKEN = "dr_owner_test-token-0123456789abcdefghijklmnopqrstuvwxyz";

export interface TestServer extends Running {
  mails: Mail[];
  telegrams: string[];
  logs: string[];
  dir: string;
  stop(): Promise<void>;
}

/** A real HTTP server on an ephemeral port, in-memory Postgres (PGlite), temp dir storage, fake notifiers. */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "doc-review-"));
  const mails: Mail[] = [];
  const telegrams: string[] = [];
  const logs: string[] = [];
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    PUBLIC_URL: "https://revision.example.test",
    DATABASE_URL: "pglite:memory",
    STORAGE_TYPE: "fs",
    STORAGE_DIR: join(dir, "files"),
    OWNER_TOKEN_SHA256: sha256Hex(OWNER_TOKEN),
    EMAIL_OWNER_TO: "autor@example.test",
    ...env,
  });
  const running = await startServer(config, {
    mailer: { send: async (m) => void mails.push(m) },
    telegram: { send: async (t) => void telegrams.push(t) },
    log: (m) => void logs.push(m),
  });
  return {
    ...running,
    mails,
    telegrams,
    logs,
    dir,
    async stop() {
      await running.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Waits for setImmediate-scheduled notifications. */
export const settle = () => new Promise((r) => setTimeout(r, 50));
