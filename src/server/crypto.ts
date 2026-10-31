import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url (43 chars). Used for links, sessions and CSRF tokens. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Secrets are high-entropy random values: a plain SHA-256 is the right hash for them. */
export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against itself so the time doesn't depend on where they differ.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Owner tokens are prefixed so they're recognizable in a config file. */
export function newOwnerToken(): string {
  return `dr_owner_${newSecret(32)}`;
}

/** Crockford's base32 alphabet: no I, L, O or U (nothing to confuse when typing). */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Characters of an enrollment code: 10 × 5 bits = 50 bits of entropy. */
export const ENROLL_CODE_CHARS = 10;

/** A one-time enrollment code, e.g. "K7Q2X-9XMPA" (two groups of five). */
export function newEnrollCode(): string {
  let s = "";
  for (let i = 0; i < ENROLL_CODE_CHARS; i++) s += CROCKFORD[randomInt(32)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/**
 * An enrollment code as typed → its canonical form (10 characters, no
 * hyphen), or null. Case, spaces and hyphens don't matter; I and L read as 1,
 * O as 0 (Crockford's decoding rules).
 */
export function normalizeEnrollCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return s.length === ENROLL_CODE_CHARS && [...s].every((ch) => CROCKFORD.includes(ch)) ? s : null;
}
