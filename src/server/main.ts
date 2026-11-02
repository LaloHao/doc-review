import { createServer, type Server } from "node:http";
import { describeConfig, reviewerDigestHour, type Config } from "../config.js";
import { migrate, openDb, pendingMigrations, type Db } from "../db/db.js";
import { Notifier, smtpMailer, telegramClient, type Mailer, type Telegram } from "../notify/notify.js";
import { OWNER, ownerSessionFingerprint, Repo } from "../repo.js";
import { openStore, type BlobStore } from "../storage.js";
import { createTelemetry, type Logger, type Telemetry } from "../telemetry/index.js";
import { instrumentDb, instrumentMailer, instrumentStore, instrumentTelegram } from "../telemetry/instrument.js";
import { startMetricsServer } from "../telemetry/metrics.js";
import { APP_VERSION } from "../version.js";
import { createApp } from "./app.js";

export interface Running {
  server: Server;
  url: string;
  repo: Repo;
  telemetry: Telemetry;
  /** The separate metrics listener (METRICS_PORT), if on. */
  metricsServer: Server | null;
  metricsUrl: string | null;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Injected in tests (no network). */
  mailer?: Mailer | null;
  telegram?: Telegram | null;
  store?: BlobStore;
  db?: Db;
  /** Where log lines go (default: stdout), in LOG_FORMAT. */
  log?: (line: string) => void;
  /** A ready telemetry (tests); default: from config.telemetry. */
  telemetry?: Telemetry;
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
 * Sends the owner's daily digest of each document once per local day, at or
 * after DIGEST_HOUR. A day is marked only once its digest went out (or there was
 * nothing to send): if every channel failed, the next check tries again.
 * Returns how many digests went out.
 */
export async function runDigest(config: Config, repo: Repo, notifier: Notifier, now: Date): Promise<number> {
  if (config.digestHour === null) return 0;
  const { day, hour } = localDayHour(now, config.timeZone);
  if (hour < config.digestHour) return 0;
  const since = new Date(now.getTime() - 24 * 3600_000);
  let sent = 0;
  for (const doc of await repo.listDocuments()) {
    if (await repo.digestDone(doc.id, day)) continue;
    const threads = await repo.listThreads(doc, OWNER, { since });
    const r = await notifier.digest(doc, threads, since);
    if (r === "failed") continue;
    await repo.markDigest(doc.id, day);
    if (r === "sent") sent++;
  }
  return sent;
}

/**
 * Daily digests for the reviewers who chose them: replies since their last
 * digest (at most a week back), once per local day and invitation (each in its
 * document's language). Returns how many went out.
 */
export async function runReviewerDigests(
  config: Config,
  repo: Repo,
  notifier: Notifier,
  now: Date,
  log: (m: string) => void = () => undefined,
): Promise<number> {
  if (!notifier.enabled.reviewerEmail) return 0;
  const { day, hour } = localDayHour(now, config.timeZone);
  if (hour < reviewerDigestHour(config)) return 0;
  let sent = 0;
  for (const doc of await repo.listDocuments()) {
    for (const inv of await repo.invitationsOfDocument(doc.id)) {
      const p = inv.person;
      if (inv.revoked_at || p.notify_replies !== "daily" || !p.email) continue;
      if (await repo.reviewerDigestDone(inv.id, day)) continue;
      const last = await repo.lastReviewerDigest(inv.id);
      const since = new Date(Math.max(last?.getTime() ?? 0, now.getTime() - 24 * 3600_000 * (last ? 7 : 1)));
      const items = await repo.reviewerUpdates(doc, p.id, since);
      try {
        if (await notifier.reviewerDigest(doc, p, items)) sent++;
        await repo.markReviewerDigest(inv.id, day);
      } catch (e) {
        log(`reviewer digest failed for invitation #${inv.id}: ${(e as Error).message}`);
      }
    }
  }
  return sent;
}

/** Applies the migrations (span db.migrate) and logs what was applied. */
async function migrateLogged(db: Db, tel: Telemetry): Promise<void> {
  const applied = await tel.tracer.withSpan("db.migrate", {}, async (span) => {
    const a = await migrate(db);
    span?.setAttribute("docreview.migrations.applied", a.length);
    return a;
  });
  if (applied.length) tel.log.info("migrations_applied", `migrations applied: ${applied.join(", ")}`, { migrations: applied.join(","), count: applied.length });
}

const dbSystem = (url: string) => (url.startsWith("pglite:") ? "pglite" : "postgresql");

export async function startServer(config: Config, opts: StartOptions = {}): Promise<Running> {
  const tel = opts.telemetry ?? createTelemetry(config.telemetry, { sink: opts.log });
  const log: Logger = tel.log;
  const open = async (url: string) => instrumentDb(await openDb(url, { log }), tel, dbSystem(url));
  let db = opts.db ? instrumentDb(opts.db, tel, dbSystem(config.databaseUrl)) : undefined;
  if (!db && !config.migrateOnStart) {
    // Migrations ran elsewhere (the chart's hook Job, with the admin role).
    db = await open(config.databaseUrl);
    const pending = await pendingMigrations(db);
    if (pending.length) {
      await db.close();
      throw new Error(`pending migrations: ${pending.join(", ")} (run doc-review migrate with DATABASE_ADMIN_URL)`);
    }
  }
  if (!db) {
    if (config.databaseAdminUrl !== config.databaseUrl) {
      const admin = await open(config.databaseAdminUrl);
      try {
        await migrateLogged(admin, tel);
      } finally {
        await admin.close();
      }
      db = await open(config.databaseUrl);
    } else {
      db = await open(config.databaseUrl);
      await migrateLogged(db, tel);
    }
  }
  const repo = new Repo(db, config.ownerName, ownerSessionFingerprint(config.ownerTokenSha256));
  const stale = await repo.purgeStaleOwnerSessions();
  if (stale) log.info("owner_sessions_purged", `owner credentials changed: ${stale} owner session(s) closed`, { sessions: stale });
  const store = instrumentStore(opts.store ?? openStore(config.storage), tel, config.storage.type);
  const telegram = opts.telegram !== undefined ? opts.telegram : config.telegram ? telegramClient(config.telegram) : null;
  const mailer = opts.mailer !== undefined ? opts.mailer : config.smtp ? await smtpMailer(config.smtp) : null;
  const notifier = new Notifier({
    publicUrl: config.publicUrl,
    telegram: instrumentTelegram(telegram, tel),
    mailer: instrumentMailer(mailer, tel),
    ownerEmail: config.ownerEmail,
    instant: config.notifyInstant,
    log: (m) => log.warn("notification_failed", m),
  });
  const app = createApp({ config, repo, store, notifier, telemetry: tel });
  // Long enough to upload the largest PDF at ~100 KB/s (50 MB: about 8.5 min);
  // headers must still arrive within 30 s.
  const requestTimeout = Math.max(120_000, Math.ceil(config.maxPdfBytes / (100 * 1024)) * 1000);
  const server = createServer({ requestTimeout, headersTimeout: 30_000 }, (req, res) => {
    void app.handle(req, res);
  });
  await new Promise<void>((ok) => server.listen(config.port, config.host, ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  let metricsServer: Server | null = null;
  let metricsPort: number | null = null;
  if (config.telemetry.metricsPort !== null) {
    try {
      metricsServer = await startMetricsServer(tel.metrics, config.telemetry.metricsPort, config.host);
    } catch (e) {
      await new Promise<void>((ok) => server.close(() => ok()));
      await db.close();
      throw e;
    }
    const a = metricsServer.address();
    metricsPort = typeof a === "object" && a ? a.port : config.telemetry.metricsPort;
  }
  const t = config.telemetry;
  log.info("startup", `doc-review listening on ${config.host}:${port} (${describeConfig(config)})`, {
    version: APP_VERSION,
    host: config.host,
    port,
    public_url: config.publicUrl,
    database: config.databaseUrl.startsWith("pglite:") ? "pglite" : "postgres",
    storage: config.storage.type,
    owner_access: config.ownerTokenSha256 !== "",
    telegram: config.telegram !== null,
    email: config.smtp !== null,
    digest_hour: config.digestHour,
    time_zone: config.timeZone,
    log_level: t.logLevel,
    log_identities: t.logIdentities,
    traces: t.traces !== null,
    traces_endpoint_host: t.traces ? new URL(t.traces.url).host : null,
    trace_sample_ratio: t.traces?.sampleRatio,
    metrics_port: metricsPort,
  });

  const now = opts.now ?? (() => new Date());
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // a slow SMTP server must not make two runs overlap
    ticking = true;
    try {
      await tel.tracer.withSpan("digest.run", {}, async (span) => {
        await repo.purgeExpiredSessions();
        await repo.purgeEnrollCodes();
        const d = await runDigest(config, repo, notifier, now());
        if (d) log.info("digests_sent", `daily digests sent: ${d}`, { count: d });
        const n = await runReviewerDigests(config, repo, notifier, now(), (m) => log.warn("reviewer_digest_failed", m));
        if (n) log.info("reviewer_digests_sent", `reviewer digests sent: ${n}`, { count: n });
        span?.setAttributes({ "docreview.digests.owner": d, "docreview.digests.reviewer": n });
      });
    } catch (e) {
      log.error("digest_error", `digest error: ${(e as Error).message}`, {}, { error: e });
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
    telemetry: tel,
    metricsServer,
    metricsUrl: metricsPort !== null ? `http://127.0.0.1:${metricsPort}/metrics` : null,
    async close() {
      clearInterval(timer);
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections();
      if (metricsServer) {
        const m = metricsServer;
        const mClosed = new Promise<void>((ok) => m.close(() => ok()));
        m.closeAllConnections();
        await mClosed;
      }
      await closed;
      await db!.close();
      // Pending spans go out with a short timeout; a dead collector can't hold up the exit.
      await tel.shutdown(2000);
    },
  };
}
