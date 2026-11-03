// Server configuration, read from the environment. Secrets (owner token hash, bot
// token, SMTP password, S3 keys, database DSNs) only come from here and are never
// logged: `describeConfig` prints what is enabled, not the values.

export type StorageConfig =
  | { type: "fs"; dir: string }
  | {
      type: "s3";
      bucket: string;
      prefix: string;
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

export type SmtpSecurity = "starttls" | "tls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: string;
  from: string;
}

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  /** Origin of publicUrl, for the CSRF origin check. */
  origin: string;
  databaseUrl: string;
  /** DSN used to run migrations (the CNPG `<app>_admin` role); defaults to databaseUrl. */
  databaseAdminUrl: string;
  /** Run migrations at startup; false = a separate job does (the app only checks). */
  migrateOnStart: boolean;
  storage: StorageConfig;
  /** SHA-256 (hex) of the owner token. Empty = owner access disabled. */
  ownerTokenSha256: string;
  ownerName: string;
  /** Read the client IP from CF-Connecting-IP (behind Cloudflare Tunnel). */
  trustCloudflare: boolean;
  maxPdfBytes: number;
  /** New threads + replies per reviewer in 24 hours, all documents together (0 = no cap). */
  maxReviewerCommentsPerDay: number;
  telegram: { botToken: string; chatId: string } | null;
  smtp: SmtpConfig | null;
  /** Owner address for email notifications ("" = no owner emails). */
  ownerEmail: string;
  /** Send a notification on every new comment/reply. */
  notifyInstant: boolean;
  /** Hour (0-23, in TZ) of the owner's daily digest; null = no digest. */
  digestHour: number | null;
  timeZone: string;
  /** Logs, traces and metrics: all optional, off by default. */
  telemetry: TelemetryConfig;
  /** The privacy notice reviewers see (link, footer and /privacy); null = none. */
  privacy: PrivacyConfig | null;
}

export type LogFormat = "text" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface TracesConfig {
  /** Where spans are POSTed (OTLP/HTTP JSON): …/v1/traces. */
  url: string;
  /** OTEL_EXPORTER_OTLP_HEADERS (auth). Secret: never logged. */
  headers: Record<string, string>;
  serviceName: string;
  /** OTEL_RESOURCE_ATTRIBUTES. */
  resourceAttributes: Record<string, string>;
  /** Share of new traces kept (0-1); traces continued from a traceparent follow its sampled flag. */
  sampleRatio: number;
}

export interface PrivacyConfig {
  /** Who reviewers write to about their data; "" = the owner, by name. */
  contact: string;
  /** How long the logs keep it (days); null = not said. */
  retentionDays: number | null;
}

export interface TelemetryConfig {
  logFormat: LogFormat;
  logLevel: LogLevel;
  /** Add who made each request (person, email, client IP, user agent) to log lines. */
  logIdentities: boolean;
  /** null = no tracing (OTEL_EXPORTER_OTLP_ENDPOINT unset, or OTEL_SDK_DISABLED). */
  traces: TracesConfig | null;
  /** Port of the separate /metrics listener; null = no metrics. */
  metricsPort: number | null;
}

function str(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const v = env[name];
  return v === undefined ? fallback : v.trim();
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = str(env, name).toLowerCase();
  if (v === "") return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = str(env, name);
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

/** "k=v,k=v" (OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_HEADERS); values may be percent-encoded. */
export function parseKeyValues(s: string, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    if (part.trim() === "") continue;
    const i = part.indexOf("=");
    const k = i > 0 ? part.slice(0, i).trim() : "";
    // The value itself is never put in the error: these may be credentials.
    if (!k) throw new Error(`${name} must be a list of key=value pairs`);
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // Not percent-encoded: keep it as written.
    }
    out[k] = v;
  }
  return out;
}

export function loadTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const logFormat = (str(env, "LOG_FORMAT", "text").toLowerCase() || "text") as LogFormat;
  if (!["text", "json"].includes(logFormat)) throw new Error("LOG_FORMAT must be text or json");
  const logLevel = (str(env, "LOG_LEVEL", "info").toLowerCase() || "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn or error");

  let traces: TracesConfig | null = null;
  const base = str(env, "OTEL_EXPORTER_OTLP_ENDPOINT").replace(/\/+$/, "");
  const tracesUrl = str(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  if ((base || tracesUrl) && !bool(env, "OTEL_SDK_DISABLED", false)) {
    const url = tracesUrl || `${base}/v1/traces`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL");
    const ratioRaw = str(env, "OTEL_TRACES_SAMPLER_ARG");
    const sampleRatio = ratioRaw === "" ? 1 : Number(ratioRaw);
    if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1) throw new Error("OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1");
    const resourceAttributes = parseKeyValues(str(env, "OTEL_RESOURCE_ATTRIBUTES"), "OTEL_RESOURCE_ATTRIBUTES");
    traces = {
      url,
      headers: parseKeyValues(str(env, "OTEL_EXPORTER_OTLP_HEADERS"), "OTEL_EXPORTER_OTLP_HEADERS"),
      serviceName: str(env, "OTEL_SERVICE_NAME") || resourceAttributes["service.name"] || "doc-review",
      resourceAttributes,
      sampleRatio,
    };
  }

  let metricsPort: number | null = null;
  if (str(env, "METRICS_PORT") !== "") {
    metricsPort = int(env, "METRICS_PORT", 0);
    if (metricsPort < 0 || metricsPort > 65535) throw new Error("METRICS_PORT must be 0-65535");
  }

  return { logFormat, logLevel, logIdentities: bool(env, "LOG_IDENTITIES", false), traces, metricsPort };
}

/**
 * The privacy notice: on with LOG_IDENTITIES (the logs then keep reviewers'
 * personal data) unless PRIVACY_NOTICE=false; PRIVACY_NOTICE=true shows it
 * anyway. PRIVACY_CONTACT (default EMAIL_OWNER_TO) and LOG_RETENTION_DAYS go
 * in its text.
 */
export function loadPrivacyConfig(env: NodeJS.ProcessEnv, logIdentities: boolean, ownerEmail: string): PrivacyConfig | null {
  if (!bool(env, "PRIVACY_NOTICE", logIdentities)) return null;
  const days = str(env, "LOG_RETENTION_DAYS");
  const retentionDays = days === "" ? null : int(env, "LOG_RETENTION_DAYS", 0);
  if (retentionDays !== null && retentionDays < 1) throw new Error("LOG_RETENTION_DAYS must be a positive number of days");
  return { contact: str(env, "PRIVACY_CONTACT", ownerEmail), retentionDays };
}

export function parseS3Url(url: string): { bucket: string; prefix: string } {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!m || !m[1]) throw new Error("S3_URL must look like s3://bucket[/prefix]");
  const prefix = (m[2] ?? "").replace(/\/+$/, "");
  return { bucket: m[1], prefix: prefix ? prefix + "/" : "" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = str(env, "PUBLIC_URL", "http://localhost:8080").replace(/\/+$/, "");
  const origin = new URL(publicUrl).origin;
  const dataDir = str(env, "DATA_DIR", "./data");
  const databaseUrl = str(env, "DATABASE_URL", `pglite:${dataDir}/pglite`);

  let storage: StorageConfig;
  const storageType = str(env, "STORAGE_TYPE", "fs");
  if (storageType === "s3") {
    const { bucket, prefix } = parseS3Url(str(env, "S3_URL"));
    const endpoint = str(env, "S3_ENDPOINT");
    const accessKeyId = str(env, "AWS_ACCESS_KEY_ID");
    const secretAccessKey = str(env, "AWS_SECRET_ACCESS_KEY");
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("STORAGE_TYPE=s3 needs S3_ENDPOINT, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
    }
    storage = {
      type: "s3",
      bucket,
      prefix,
      endpoint: endpoint.replace(/\/+$/, ""),
      region: str(env, "S3_REGION", "auto"),
      accessKeyId,
      secretAccessKey,
    };
  } else if (storageType === "fs") {
    storage = { type: "fs", dir: str(env, "STORAGE_DIR", `${dataDir}/files`) };
  } else {
    throw new Error("STORAGE_TYPE must be fs or s3");
  }

  const ownerTokenSha256 = str(env, "OWNER_TOKEN_SHA256").toLowerCase();
  if (ownerTokenSha256 && !/^[0-9a-f]{64}$/.test(ownerTokenSha256)) {
    throw new Error("OWNER_TOKEN_SHA256 must be 64 hex characters (doc-review gen-token)");
  }

  const botToken = str(env, "TELEGRAM_BOT_TOKEN");
  const chatId = str(env, "TELEGRAM_CHAT_ID");
  const telegram = botToken && chatId ? { botToken, chatId } : null;

  let smtp: SmtpConfig | null = null;
  const smtpHost = str(env, "SMTP_HOST");
  if (smtpHost) {
    const security = str(env, "SMTP_SECURITY", "starttls") as SmtpSecurity;
    if (!["starttls", "tls", "none"].includes(security)) {
      throw new Error("SMTP_SECURITY must be starttls, tls or none");
    }
    if (security === "none" && !["localhost", "127.0.0.1", "::1"].includes(smtpHost)) {
      throw new Error("SMTP_SECURITY=none is only allowed for a local SMTP relay");
    }
    const from = str(env, "SMTP_FROM", str(env, "SMTP_USER"));
    if (!from) throw new Error("SMTP_FROM (or SMTP_USER) is required with SMTP_HOST");
    smtp = {
      host: smtpHost,
      port: int(env, "SMTP_PORT", security === "tls" ? 465 : 587),
      security,
      user: str(env, "SMTP_USER"),
      password: str(env, "SMTP_PASSWORD"),
      from,
    };
  }

  const digest = str(env, "DIGEST_HOUR");
  let digestHour: number | null = null;
  if (digest !== "") {
    digestHour = int(env, "DIGEST_HOUR", 8);
    if (digestHour < 0 || digestHour > 23) throw new Error("DIGEST_HOUR must be 0-23");
  }

  const telemetry = loadTelemetryConfig(env);
  return {
    host: str(env, "HOST", "0.0.0.0"),
    port: int(env, "PORT", 8080),
    publicUrl,
    origin,
    databaseUrl,
    databaseAdminUrl: str(env, "DATABASE_ADMIN_URL", databaseUrl),
    migrateOnStart: bool(env, "MIGRATE_ON_START", true),
    storage,
    ownerTokenSha256,
    ownerName: str(env, "OWNER_NAME", "Owner") || "Owner",
    trustCloudflare: str(env, "TRUST_PROXY") === "cloudflare",
    maxPdfBytes: int(env, "MAX_PDF_MB", 50) * 1024 * 1024,
    maxReviewerCommentsPerDay: int(env, "MAX_REVIEWER_COMMENTS_PER_DAY", 500),
    telegram,
    smtp,
    ownerEmail: str(env, "EMAIL_OWNER_TO"),
    notifyInstant: bool(env, "NOTIFY_INSTANT", true),
    digestHour,
    timeZone: str(env, "TZ", "America/Mexico_City") || "America/Mexico_City",
    telemetry,
    privacy: loadPrivacyConfig(env, telemetry.logIdentities, str(env, "EMAIL_OWNER_TO")),
  };
}

/** Hour of the reviewers' daily reply digests: DIGEST_HOUR, or 8:00 when unset. */
export const reviewerDigestHour = (c: Config): number => c.digestHour ?? 8;

/** Telemetry that is on, without endpoints' credentials; "" when everything is off. */
export function describeTelemetry(t: TelemetryConfig): string {
  const parts = [
    t.logFormat !== "text" ? `logs ${t.logFormat}` : null,
    t.logLevel !== "info" ? `log level ${t.logLevel}` : null,
    t.logIdentities ? "identities logged (LOG_IDENTITIES)" : null,
    t.traces ? `traces on (${new URL(t.traces.url).host}, service ${t.traces.serviceName}${t.traces.sampleRatio < 1 ? `, ratio ${t.traces.sampleRatio}` : ""})` : null,
    t.metricsPort !== null ? `metrics on :${t.metricsPort}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/** What is enabled, without any secret value. */
export function describeConfig(c: Config): string {
  const tel = describeTelemetry(c.telemetry);
  return [
    `public url ${c.publicUrl}`,
    `database ${c.databaseUrl.startsWith("pglite:") ? "pglite (embedded)" : "postgres"}`,
    `storage ${c.storage.type}`,
    `owner access ${c.ownerTokenSha256 ? "on" : "OFF (OWNER_TOKEN_SHA256 unset)"}`,
    `telegram ${c.telegram ? "on" : "off"}`,
    `email ${c.smtp ? `on (${c.smtp.host}:${c.smtp.port} ${c.smtp.security})` : "off"}`,
    `digest ${c.digestHour === null ? "off" : `${c.digestHour}:00 ${c.timeZone}`}`,
    tel || null,
  ]
    .filter(Boolean)
    .join(", ");
}
