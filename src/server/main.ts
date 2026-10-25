import { createServer, type Server } from "node:http";
import { describeConfig, type Config } from "../config.js";
import { migrate, openDb, type Db } from "../db/db.js";
import { Notifier, smtpMailer, telegramClient, type Mailer, type Telegram } from "../notify/notify.js";
import { Repo } from "../repo.js";
import { openStore, type BlobStore } from "../storage.js";
import { createApp } from "./app.js";

export interface Running {
  server: Server;
  url: string;
  repo: Repo;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Injected in tests (no network). */
  mailer?: Mailer | null;
  telegram?: Telegram | null;
  store?: BlobStore;
  db?: Db;
  log?: (msg: string) => void;
  /** Check for the digest this often (ms). */
  digestEveryMs?: number;
  now?: () => Date;
}

/** Local date (YYYY-MM-DD) and hour in a time zone. */
export function localDayHour(d: Date, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Sends the daily digest once per local day, at or after DIGEST_HOUR. */
export async function runDigest(config: Config, repo: Repo, notifier: Notifier, now: Date): Promise<boolean> {
  if (config.digestHour === null) return false;
  const { day, hour } = localDayHour(now, config.timeZone);
  if (hour < config.digestHour) return false;
  if (!(await repo.claimDigest(day))) return false;
  const since = new Date(now.getTime() - 24 * 3600_000);
  const threads = await repo.listThreads({ kind: "owner", directorId: null }, { since });
  return notifier.digest(threads, since);
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<Running> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let db = opts.db;
  if (!db) {
    if (config.databaseAdminUrl !== config.databaseUrl) {
      const admin = await openDb(config.databaseAdminUrl);
      try {
        const applied = await migrate(admin);
        if (applied.length) log(`migrations applied: ${applied.join(", ")}`);
      } finally {
        await admin.close();
      }
      db = await openDb(config.databaseUrl);
    } else {
      db = await openDb(config.databaseUrl);
      const applied = await migrate(db);
      if (applied.length) log(`migrations applied: ${applied.join(", ")}`);
    }
  }
  const repo = new Repo(db, config.ownerName);
  const store = opts.store ?? openStore(config.storage);
  const telegram = opts.telegram !== undefined ? opts.telegram : config.telegram ? telegramClient(config.telegram) : null;
  const mailer = opts.mailer !== undefined ? opts.mailer : config.smtp ? await smtpMailer(config.smtp) : null;
  const notifier = new Notifier({
    publicUrl: config.publicUrl,
    thesisTitle: async () => (await repo.latestVersion())?.title ?? "la tesis",
    telegram,
    mailer,
    ownerEmail: config.ownerEmail,
    instant: config.notifyInstant,
    log,
  });
  const app = createApp({ config, repo, store, notifier, log });
  const server = createServer({ requestTimeout: 120_000, headersTimeout: 30_000 }, (req, res) => {
    void app.handle(req, res);
  });
  await new Promise<void>((ok) => server.listen(config.port, config.host, ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  log(`revision-tesis listening on ${config.host}:${port} (${describeConfig(config)})`);

  const now = opts.now ?? (() => new Date());
  const tick = async () => {
    try {
      await repo.purgeExpiredSessions();
      if (await runDigest(config, repo, notifier, now())) log("daily digest sent");
    } catch (e) {
      log(`digest error: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(() => void tick(), opts.digestEveryMs ?? 5 * 60_000);
  timer.unref();

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    repo,
    async close() {
      clearInterval(timer);
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections();
      await closed;
      await db!.close();
    },
  };
}
