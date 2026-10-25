// Fixed-window rate limiter in memory. The app runs as a single replica; with
// more replicas this would need to move to the database.

import { isIPv4, isIPv6 } from "node:net";

export class RateLimiter {
  /** Insertion order is age order: the first entries are the oldest windows. */
  private hits = new Map<string, { count: number; reset: number }>();
  private nextSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Keys kept at most; past it the oldest windows are dropped. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit; returns seconds to wait when over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    // Expired windows are swept at most once per window, not on every hit.
    if (t >= this.nextSweep) {
      for (const [k, e] of this.hits) if (e.reset <= t) this.hits.delete(k);
      this.nextSweep = t + this.windowMs;
    }
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      if (e) this.hits.delete(key);
      e = { count: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
      while (this.hits.size > this.maxKeys) {
        const oldest = this.hits.keys().next().value as string;
        this.hits.delete(oldest);
      }
    }
    e.count++;
    return e.count > this.limit ? Math.ceil((e.reset - t) / 1000) : 0;
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Expands an IPv6 address to its 8 hextets. */
function hextets(ip: string): string[] {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  // An embedded IPv4 tail (…:1.2.3.4) counts as two hextets.
  const last = (b.length ? b : a).at(-1) ?? "";
  if (isIPv4(last)) {
    const [w, x, y, z] = last.split(".").map(Number) as [number, number, number, number];
    (b.length ? b : a).splice(-1, 1, ((w << 8) | x).toString(16), ((y << 8) | z).toString(16));
  }
  const fill = tail === null ? [] : Array<string>(8 - a.length - b.length).fill("0");
  return [...a, ...fill, ...b].map((h) => (parseInt(h, 16) || 0).toString(16));
}

/**
 * The rate-limit key of a client address. IPv6 clients usually get a whole /64,
 * so they are limited per /64 (one address each would be no limit at all);
 * IPv4-mapped IPv6 addresses count as IPv4.
 */
export function ipBucket(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!isIPv6(ip)) return ip;
  return `${hextets(ip.split("%")[0]!).slice(0, 4).join(":")}::/64`;
}
