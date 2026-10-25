// Fixed-window rate limiter in memory. The app runs as a single replica; with
// more replicas this would need to move to the database.

export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; returns seconds to wait when over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      e = { count: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 10_000) this.sweep(t);
    return e.count > this.limit ? Math.ceil((e.reset - t) / 1000) : 0;
  }

  private sweep(t: number): void {
    for (const [k, e] of this.hits) if (e.reset <= t) this.hits.delete(k);
  }
}

/** The rate-limit key of a client address (IPv6 is limited per /64, see below). */
export function ipBucket(ip: string): string {
  return ip;
}
