// The server's logger. Two formats:
// - text (default): the message alone, one line, exactly as doc-review always
//   logged it. Events added with telemetry (one line per request, notification
//   sends…) are debug-level in this format, so the default output is unchanged.
// - json: one object per line ({time, level, event, msg, trace_id, span_id,
//   …fields}) for a log pipeline such as Alloy → Loki.
// Messages and error stacks are scrubbed (sanitize.ts). Identity fields (names,
// emails, client IPs) are only ever added with LOG_IDENTITIES=true.

import { sanitizeError, sanitizeText } from "./sanitize.js";
import { currentScope } from "./scope.js";

export type Level = "debug" | "info" | "warn" | "error";
export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];
export type LogFormat = "text" | "json";

export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface LogOptions {
  /** The text-format line, when it differs from msg (kept as it always was). */
  text?: string;
  /** A telemetry-era event: info in JSON, debug in text (the text output stays as it was). */
  quietText?: boolean;
  /** An error: its class, message and stack (scrubbed) go in error_* fields. */
  error?: unknown;
}

export interface Logger {
  readonly format: LogFormat;
  /** Identities (who, client IP, user agent) are added to log lines. */
  readonly identities: boolean;
  enabled(level: Level): boolean;
  log(level: Level, event: string, msg: string, fields?: Fields, opts?: LogOptions): void;
  debug(event: string, msg: string, fields?: Fields, opts?: LogOptions): void;
  info(event: string, msg: string, fields?: Fields, opts?: LogOptions): void;
  warn(event: string, msg: string, fields?: Fields, opts?: LogOptions): void;
  error(event: string, msg: string, fields?: Fields, opts?: LogOptions): void;
}

export interface LoggerOptions {
  format?: LogFormat;
  level?: Level;
  identities?: boolean;
  /** Where lines go (default: stdout). Tests collect them. */
  sink?: (line: string) => void;
  now?: () => Date;
}

const rank = (l: Level) => LEVELS.indexOf(l);

export function createLogger(o: LoggerOptions = {}): Logger {
  const format = o.format ?? "text";
  const min = rank(o.level ?? "info");
  const identities = o.identities ?? false;
  const sink = o.sink ?? ((line: string) => console.log(line));
  const now = o.now ?? (() => new Date());

  const log = (level: Level, event: string, msg: string, fields: Fields = {}, opts: LogOptions = {}) => {
    const effective = opts.quietText && format === "text" ? "debug" : level;
    if (rank(effective) < min) return;
    const scope = currentScope();
    const who = identities ? scope?.identity : null;
    if (format === "text") {
      let line = sanitizeText(opts.text ?? msg, 16_000);
      if (who && Object.keys(who).length) line += ` [${Object.entries(who).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}]`;
      sink(line);
      return;
    }
    const out: Record<string, unknown> = { time: now().toISOString(), level, event, msg: sanitizeText(msg) };
    const span = scope?.span;
    if (span) {
      out.trace_id = span.ctx.traceId;
      out.span_id = span.ctx.spanId;
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || k in out) continue;
      out[k] = typeof v === "string" ? sanitizeText(v, 1000) : v;
    }
    if (opts.error !== undefined) {
      const e = sanitizeError(opts.error);
      out.error_type = e.type;
      out.error_message = e.message;
      out.error_stack = e.stack;
    }
    // Identity values are personal data the operator asked for: not scrubbed.
    if (who) for (const [k, v] of Object.entries(who)) if (!(k in out)) out[k] = v;
    sink(JSON.stringify(out));
  };

  return {
    format,
    identities,
    enabled: (l) => rank(l) >= min,
    log,
    debug: (e, m, f, o2) => log("debug", e, m, f, o2),
    info: (e, m, f, o2) => log("info", e, m, f, o2),
    warn: (e, m, f, o2) => log("warn", e, m, f, o2),
    error: (e, m, f, o2) => log("error", e, m, f, o2),
  };
}
