import { createServer, type Server } from "node:http";
import { describeConfig, directorDigestHour, type Config } from "../config.js";
import { migrate, openDb, pendingMigrations, type Db } from "../db/db.js";
import { Notifier, smtpMailer, telegramClient, type Mailer, type Telegram } from "../notify/notify.js";
import { ownerSessionFingerprint, Repo } from "../repo.js";
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

/**
 * Sends the owner's daily digest once per local day, at or after DIGEST_HOUR.
 * The day is marked only once the digest went out (or there was nothing to
 * send): if every channel failed, the next check tries again.
 */
export async function runDigest(config: Config, repo: Repo, notifier: Notifier, now: Date): Promise<boolean> {
  if (config.digestHour === null) return false;
  const { day, hour } = localDayHour(now, config.timeZone);
  if (hour < config.digestHour) return false;
  if (await repo.digestDone(day)) return false;
  const since = new Date(now.getTime() - 24 * 3600_000);
  const threads = await repo.listThreads({ kind: "owner", directorId: null }, { since });
  const r = await notifier.digest(threads, since);
  if (r === "failed") return false;
  await repo.markDigest(day);
  return r === "sent";
}

/**
 * Daily digests for the directors who chose them: replies since their last
 * digest (at most a week back), once per local day. Returns how many went out.
 */
export async function runDirectorDigests(
  config: Config,
  repo: Repo,
  notifier: Notifier,
  now: Date,
  log: (m: string) => void = () => undefined,
): Promise<number> {
  if (!notifier.enabled.directorEmail) return 0;
  const { day, hour } = localDayHour(now, config.timeZone);
  if (hour < directorDigestHour(config)) return 0;
  let sent = 0;
  for (const d of await repo.listDirectors()) {
    if (d.notify_replies !== "daily" || !d.email || d.revoked_at) continue;
    if (await repo.directorDigestDone(d.id, day)) continue;
    const last = await repo.lastDirectorDigest(d.id);
    const since = new Date(Math.max(last?.getTime() ?? 0, now.getTime() - 24 * 3600_000 * (last ? 7 : 1)));
    const items = await repo.directorUpdates(d.id, since);
    try {
      if (await notifier.directorDigest(d, items)) sent++;
      await repo.markDirectorDigest(d.id, day);
    } catch (e) {
      log(`director digest failed for director #${d.id}: ${(e as Error).message}`);
    }
  }
  return sent;
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<Running> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let db = opts.db;
  if (!db && !config.migrateOnStart) {
    // Migrations ran elsewhere (the chart's hook Job, with the admin role).
    db = await openDb(config.databaseUrl);
    const pending = await pendingMigrations(db);
    if (pending.length) {
      await db.close();
      throw new Error(`pending migrations: ${pending.join(", ")} (run doc-review migrate with DATABASE_ADMIN_URL)`);
    }
  }
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
  const repo = new Repo(db, config.ownerName, ownerSessionFingerprint(config.ownerTokenSha256));
  const stale = await repo.purgeStaleOwnerSessions();
  if (stale) log(`owner token changed: ${stale} owner session(s) closed`);
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
  // Long enough to upload the largest PDF at ~100 KB/s (50 MB: about 8.5 min);
  // headers must still arrive within 30 s.
  const requestTimeout = Math.max(120_000, Math.ceil(config.maxPdfBytes / (100 * 1024)) * 1000);
  const server = createServer({ requestTimeout, headersTimeout: 30_000 }, (req, res) => {
    void app.handle(req, res);
  });
  await new Promise<void>((ok) => server.listen(config.port, config.host, ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  log(`doc-review listening on ${config.host}:${port} (${describeConfig(config)})`);

  const now = opts.now ?? (() => new Date());
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a slow SMTP server must not make two runs overlap
    ticking = true;
    try {
      await repo.purgeExpiredSessions();
      if (await runDigest(config, repo, notifier, now())) log("daily digest sent");
      const n = await runDirectorDigests(config, repo, notifier, now(), log);
      if (n) log(`director digests sent: ${n}`);
    } catch (e) {
      log(`digest error: ${(e as Error).message}`);
    } finally {
      ticking = false;
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
