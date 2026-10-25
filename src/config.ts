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
  storage: StorageConfig;
  /** SHA-256 (hex) of the owner token. Empty = owner access disabled. */
  ownerTokenSha256: string;
  ownerName: string;
  /** Read the client IP from CF-Connecting-IP (behind Cloudflare Tunnel). */
  trustCloudflare: boolean;
  maxPdfBytes: number;
  /** New threads + replies per director in 24 hours (0 = no cap). */
  maxDirectorCommentsPerDay: number;
  telegram: { botToken: string; chatId: string } | null;
  smtp: SmtpConfig | null;
  /** Owner address for email notifications ("" = no owner emails). */
  ownerEmail: string;
  /** Send a notification on every new comment/reply. */
  notifyInstant: boolean;
  /** Hour (0-23, in TZ) of the daily digest; null = no digest. */
  digestHour: number | null;
  timeZone: string;
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
    throw new Error("OWNER_TOKEN_SHA256 must be 64 hex characters (revision-tesis gen-token)");
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

  return {
    host: str(env, "HOST", "0.0.0.0"),
    port: int(env, "PORT", 8080),
    publicUrl,
    origin,
    databaseUrl,
    databaseAdminUrl: str(env, "DATABASE_ADMIN_URL", databaseUrl),
    storage,
    ownerTokenSha256,
    ownerName: str(env, "OWNER_NAME", "Eduardo Ejemplo"),
    trustCloudflare: str(env, "TRUST_PROXY") === "cloudflare",
    maxPdfBytes: int(env, "MAX_PDF_MB", 50) * 1024 * 1024,
    maxDirectorCommentsPerDay: int(env, "MAX_DIRECTOR_COMMENTS_PER_DAY", 500),
    telegram,
    smtp,
    ownerEmail: str(env, "EMAIL_OWNER_TO"),
    notifyInstant: bool(env, "NOTIFY_INSTANT", true),
    digestHour,
    timeZone: str(env, "TZ", "America/Mexico_City") || "America/Mexico_City",
  };
}

/** What is enabled, without any secret value. */
export function describeConfig(c: Config): string {
  return [
    `public url ${c.publicUrl}`,
    `database ${c.databaseUrl.startsWith("pglite:") ? "pglite (embedded)" : "postgres"}`,
    `storage ${c.storage.type}`,
    `owner access ${c.ownerTokenSha256 ? "on" : "OFF (OWNER_TOKEN_SHA256 unset)"}`,
    `telegram ${c.telegram ? "on" : "off"}`,
    `email ${c.smtp ? `on (${c.smtp.host}:${c.smtp.port} ${c.smtp.security})` : "off"}`,
    `digest ${c.digestHour === null ? "off" : `${c.digestHour}:00 ${c.timeZone}`}`,
  ].join(", ");
}
