// Wrappers that add spans, metrics and log events to the app's services:
// database, PDF store, SMTP and Telegram. With telemetry off they return the
// service unchanged.

import { performance } from "node:perf_hooks";
import type { Db, Queryable } from "../db/db.js";
import type { Mailer, Telegram } from "../notify/notify.js";
import type { BlobStore } from "../storage.js";
import type { Telemetry } from "./index.js";
import { sanitizeError } from "./sanitize.js";
import { SpanKind, StatusCode } from "./trace.js";

const OPERATIONS = new Set(["select", "insert", "update", "delete", "with", "begin", "commit", "rollback", "create", "alter", "drop", "set", "show"]);
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The SQL keyword and, when obvious, the table of a statement: never the text
 * or the parameters. Unknown keywords are "other" (the metric's label stays bounded).
 */
export function sqlOperation(sql: string): { operation: string; table?: string } {
  const s = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").toLowerCase();
  const kw = /^([a-z]+)/.exec(s)?.[1] ?? "";
  const operation = OPERATIONS.has(kw) ? kw : "other";
  const m =
    operation === "insert" ? /^insert\s+into\s+"?([a-z_][a-z0-9_]*)/.exec(s)
    : operation === "update" ? /^update\s+"?([a-z_][a-z0-9_]*)/.exec(s)
    : operation === "delete" ? /^delete\s+from\s+"?([a-z_][a-z0-9_]*)/.exec(s)
    : operation === "select" ? /\sfrom\s+"?([a-z_][a-z0-9_]*)/.exec(s)
    : null;
  const table = m?.[1] && IDENT.test(m[1]) ? m[1] : undefined;
  return table ? { operation, table } : { operation };
}

const seconds = (t0: number) => (performance.now() - t0) / 1000;

export function instrumentDb(db: Db, tel: Telemetry, system: "postgresql" | "pglite"): Db {
  if (!tel.tracer.enabled && !tel.metrics.enabled) return db;
  const run = async <T>(sql: string, fn: () => Promise<T>): Promise<T> => {
    const { operation, table } = sqlOperation(sql);
    const t0 = performance.now();
    try {
      return await tel.tracer.withSpan(table ? `${operation} ${table}` : operation, {
        kind: SpanKind.CLIENT,
        childOnly: true,
        attributes: { "db.system": system, "db.operation.name": operation, "db.collection.name": table },
      }, fn);
    } finally {
      tel.metrics.dbQuery(operation, seconds(t0));
    }
  };
  const wrap = (q: Queryable): Queryable => ({
    query: <T>(sql: string, params?: unknown[]) => run(sql, () => q.query<T>(sql, params)),
  });
  return {
    ...wrap(db),
    tx: (fn) => tel.tracer.withSpan("transaction", { kind: SpanKind.INTERNAL, childOnly: true, attributes: { "db.system": system } }, () => db.tx((q) => fn(wrap(q)))),
    close: () => db.close(),
  };
}

export function instrumentStore(store: BlobStore, tel: Telemetry, type: "fs" | "s3"): BlobStore {
  if (!tel.tracer.enabled) return store;
  const kind = type === "s3" ? SpanKind.CLIENT : SpanKind.INTERNAL;
  return {
    put: (key, data, contentType) =>
      tel.tracer.withSpan("blob.put", { kind, childOnly: true, attributes: { "docreview.storage.type": type, "docreview.blob.size_bytes": data.length } }, () => store.put(key, data, contentType)),
    get: (key) =>
      tel.tracer.withSpan("blob.get", { kind, childOnly: true, attributes: { "docreview.storage.type": type } }, async (span) => {
        const r = await store.get(key);
        span?.setAttribute("docreview.blob.found", r !== null);
        if (r) span?.setAttribute("docreview.blob.size_bytes", r.length);
        return r;
      }),
  };
}

/** A send on a notification channel: span, counter and a log event (never the address or the text). */
async function notifySend(tel: Telemetry, channel: "email" | "telegram", spanName: string, fn: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  try {
    await tel.tracer.withSpan(spanName, { kind: SpanKind.CLIENT, attributes: { "docreview.notification.channel": channel } }, async (span) => {
      await fn();
      span?.setStatus(StatusCode.OK);
    });
    tel.metrics.notification(channel, "ok");
    tel.log.info("notification_sent", `${channel} notification sent`, { channel, result: "ok", duration_ms: Math.round(seconds(t0) * 1000) }, { quietText: true });
  } catch (e) {
    tel.metrics.notification(channel, "failed");
    tel.log.info("notification_sent", `${channel} notification failed`, {
      channel,
      result: "failed",
      duration_ms: Math.round(seconds(t0) * 1000),
      error_type: sanitizeError(e).type,
    }, { quietText: true });
    throw e;
  }
}

export function instrumentMailer(mailer: Mailer | null, tel: Telemetry): Mailer | null {
  if (!mailer) return null;
  return { send: (mail) => notifySend(tel, "email", "smtp.send", () => mailer.send(mail)) };
}

export function instrumentTelegram(telegram: Telegram | null, tel: Telemetry): Telegram | null {
  if (!telegram) return null;
  return { send: (text) => notifySend(tel, "telegram", "telegram.sendMessage", () => telegram.send(text)) };
}
