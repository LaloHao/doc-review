// Scrubbing for anything that leaves the process as telemetry: log messages,
// error messages and stacks, span events. The app already keeps secrets out of
// its own messages; this is the safety net for third-party errors (a driver
// that echoes a DSN, a URL with a bot token, an address in an SMTP reply).

const RULES: [RegExp, string][] = [
  // Invitation links: /a/<secret> (also inside full URLs).
  [/\/a\/[A-Za-z0-9_-]{8,}/g, "/a/[hidden]"],
  // Owner and device tokens.
  [/dr_owner_[A-Za-z0-9_-]+/g, "dr_owner_[hidden]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [hidden]"],
  // Telegram bot tokens (api.telegram.org/bot<id>:<secret>).
  [/\bbot\d+:[A-Za-z0-9_-]+/g, "bot[hidden]"],
  // Credentials in URLs and DSNs: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, "$1[hidden]@"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Cookies and query-string secrets that might be quoted in an error.
  [/__Host-dr_[a-z]+=[^;\s]+/g, "__Host-dr_[hidden]"],
  [/\b(token|secret|password|code)=[^&\s]+/gi, "$1=[hidden]"],
];

/** A string with secrets, addresses and link paths masked. */
export function sanitizeText(s: string, max = 4000): string {
  let out = s.length > max ? s.slice(0, max) + "…" : s;
  for (const [re, by] of RULES) out = out.replace(re, by);
  return out;
}

export interface SanitizedError {
  type: string;
  message: string;
  stack: string;
}

/** Class, message and stack of an error, scrubbed. */
export function sanitizeError(e: unknown): SanitizedError {
  if (e instanceof Error) {
    return {
      type: e.constructor?.name || e.name || "Error",
      message: sanitizeText(e.message, 1000),
      stack: sanitizeText(e.stack ?? `${e.name}: ${e.message}`, 8000),
    };
  }
  const s = sanitizeText(String(e), 1000);
  return { type: typeof e, message: s, stack: s };
}
