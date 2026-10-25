import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
  return `rt_owner_${newSecret(32)}`;
}
