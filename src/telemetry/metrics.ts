// Prometheus metrics, hand-rolled: counters, histograms and gauges with the
// text exposition format (0.0.4), served on a separate port (METRICS_PORT),
// never on the public one. Labels are bounded by construction: route patterns,
// methods, status codes, roles, channels, SQL keywords. Each metric also caps
// its number of series.

import { createServer, type Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

type Labels = Record<string, string>;

const MAX_SERIES = 2000;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function fmtLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? "")}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

function fmtNumber(n: number): string {
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  if (Number.isNaN(n)) return "NaN";
  return String(n);
}

interface Metric {
  readonly name: string;
  expose(): string[];
}

abstract class Base implements Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
    readonly labelNames: readonly string[] = [],
  ) {}

  protected values(labels: Labels): string[] {
    return this.labelNames.map((n) => labels[n] ?? "");
  }

  protected header(): string[] {
    return [`# HELP ${this.name} ${this.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${this.name} ${this.type}`];
  }

  abstract expose(): string[];
}

export class Counter extends Base {
  private series = new Map<string, { values: string[]; n: number }>();

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, "counter", labelNames);
  }

  inc(labels: Labels = {}, by = 1): void {
    const values = this.values(labels);
    const key = values.join("\u0001");
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { values, n: 0 };
      this.series.set(key, s);
    }
    s.n += by;
  }

  get(labels: Labels = {}): number {
    return this.series.get(this.values(labels).join("\u0001"))?.n ?? 0;
  }

  expose(): string[] {
    const out = this.header();
    for (const s of this.series.values()) out.push(`${this.name}${fmtLabels(this.labelNames, s.values)} ${fmtNumber(s.n)}`);
    return out;
  }
}

/** A gauge whose value is read when scraped. */
export class Gauge extends Base {
  constructor(
    name: string,
    help: string,
    private readonly read: () => { labels?: Labels; value: number }[],
    labelNames: readonly string[] = [],
  ) {
    super(name, help, "gauge", labelNames);
  }

  expose(): string[] {
    const out = this.header();
    for (const { labels = {}, value } of this.read()) out.push(`${this.name}${fmtLabels(this.labelNames, this.values(labels))} ${fmtNumber(value)}`);
    return out;
  }
}

/** A counter whose value is read when scraped (process CPU time). */
export class ReadCounter extends Base {
  constructor(
    name: string,
    help: string,
    private readonly read: () => number,
  ) {
    super(name, help, "counter");
  }

  expose(): string[] {
    return [...this.header(), `${this.name} ${fmtNumber(this.read())}`];
  }
}

export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
export const DB_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

export class Histogram extends Base {
  private series = new Map<string, { values: string[]; counts: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    readonly buckets: readonly number[] = HTTP_BUCKETS,
  ) {
    super(name, help, "histogram", labelNames);
  }

  observe(labels: Labels, v: number): void {
    const values = this.values(labels);
    const key = values.join("\u0001");
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) s.counts[i]!++;
    s.sum += v;
    s.count++;
  }

  count(labels: Labels = {}): number {
    return this.series.get(this.values(labels).join("\u0001"))?.count ?? 0;
  }

  expose(): string[] {
    const out = this.header();
    for (const s of this.series.values()) {
      // counts[i] is already cumulative: every observation ≤ bucket i counted there.
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${fmtLabels(this.labelNames, s.values, ["le", fmtNumber(b)])} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${fmtLabels(this.labelNames, s.values, ["le", "+Inf"])} ${s.count}`);
      out.push(`${this.name}_sum${fmtLabels(this.labelNames, s.values)} ${fmtNumber(s.sum)}`);
      out.push(`${this.name}_count${fmtLabels(this.labelNames, s.values)} ${s.count}`);
    }
    return out;
  }
}

export class Registry {
  private metrics: Metric[] = [];

  register<M extends Metric>(m: M): M {
    if (this.metrics.some((x) => x.name === m.name)) throw new Error(`metric ${m.name} registered twice`);
    this.metrics.push(m);
    return m;
  }

  expose(): string {
    return this.metrics.flatMap((m) => m.expose()).join("\n") + "\n";
  }
}

// ---- The app's metrics

/** What the app records. Without METRICS_PORT every method is a no-op. */
export interface AppMetrics {
  readonly enabled: boolean;
  httpRequest(method: string, route: string, status: number, seconds: number): void;
  commentCreated(role: string): void;
  replyCreated(role: string): void;
  versionPublished(): void;
  notification(channel: "email" | "telegram", result: "ok" | "failed"): void;
  dbQuery(operation: string, seconds: number): void;
  /** The exposition text (empty when off). */
  expose(): string;
  close(): void;
}

export const NOOP_METRICS: AppMetrics = {
  enabled: false,
  httpRequest() {},
  commentCreated() {},
  replyCreated() {},
  versionPublished() {},
  notification() {},
  dbQuery() {},
  expose: () => "",
  close() {},
};

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface PromMetrics extends AppMetrics {
  registry: Registry;
  http: { total: Counter; duration: Histogram };
  comments: Counter;
  replies: Counter;
  versions: Counter;
  notifications: Counter;
  db: Histogram;
}

export function createMetrics(version: string): PromMetrics {
  const registry = new Registry();
  const total = registry.register(new Counter("docreview_http_requests_total", "HTTP requests by method, route pattern and status.", ["method", "route", "status"]));
  const duration = registry.register(new Histogram("docreview_http_request_duration_seconds", "HTTP request duration by method and route pattern.", ["method", "route"]));
  const comments = registry.register(new Counter("docreview_comments_created_total", "New threads (first comments), by author role.", ["role"]));
  const replies = registry.register(new Counter("docreview_replies_created_total", "Replies in threads, by author role.", ["role"]));
  const versions = registry.register(new Counter("docreview_versions_published_total", "Versions published."));
  const notifications = registry.register(new Counter("docreview_notifications_total", "Notification sends by channel and result.", ["channel", "result"]));
  const db = registry.register(new Histogram("docreview_db_query_duration_seconds", "Database query duration by SQL operation.", ["operation"], DB_BUCKETS));
  registry.register(new Gauge("docreview_build_info", "Build information.", () => [{ labels: { version }, value: 1 }], ["version"]));

  const startTime = Math.round((Date.now() / 1000 - process.uptime()) * 1000) / 1000;
  registry.register(new Gauge("process_start_time_seconds", "Start time of the process since the Unix epoch, in seconds.", () => [{ value: startTime }]));
  registry.register(new ReadCounter("process_cpu_seconds_total", "User and system CPU time spent, in seconds.", () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1e6;
  }));
  registry.register(new Gauge("process_resident_memory_bytes", "Resident memory size in bytes.", () => [{ value: process.memoryUsage.rss() }]));
  registry.register(new Gauge("nodejs_heap_size_used_bytes", "V8 heap used, in bytes.", () => [{ value: process.memoryUsage().heapUsed }]));
  let loop: IntervalHistogram | null = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  // Since the previous scrape; reset after each read.
  const lag = (read: (h: IntervalHistogram) => number) => () => {
    const v = loop && loop.count > 0 ? read(loop) / 1e9 : 0;
    return [{ value: Number.isFinite(v) ? v : 0 }];
  };
  registry.register(new Gauge("nodejs_eventloop_lag_seconds", "Mean event loop delay since the previous scrape, in seconds.", lag((h) => h.mean)));
  registry.register(new Gauge("nodejs_eventloop_lag_p99_seconds", "99th percentile of the event loop delay since the previous scrape, in seconds.", lag((h) => h.percentile(99))));
  registry.register(new Gauge("nodejs_eventloop_lag_max_seconds", "Maximum event loop delay since the previous scrape, in seconds.", lag((h) => h.max)));

  const method = (m: string) => (METHODS.has(m) ? m : "OTHER");
  return {
    enabled: true,
    registry,
    http: { total, duration },
    comments,
    replies,
    versions,
    notifications,
    db,
    httpRequest(m, route, status, seconds) {
      total.inc({ method: method(m), route, status: String(status) });
      duration.observe({ method: method(m), route }, seconds);
    },
    commentCreated: (role) => comments.inc({ role }),
    replyCreated: (role) => replies.inc({ role }),
    versionPublished: () => versions.inc(),
    notification: (channel, result) => notifications.inc({ channel, result }),
    dbQuery: (operation, seconds) => db.observe({ operation }, seconds),
    expose() {
      const text = registry.expose();
      loop?.reset();
      return text;
    },
    close() {
      loop?.disable();
      loop = null;
    },
  };
}

/** The metrics listener: GET /metrics only. */
export async function startMetricsServer(metrics: AppMetrics, port: number, host: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    if (path !== "/metrics") {
      res.statusCode = 404;
      return res.end("not found\n");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      return res.end();
    }
    let body: string;
    try {
      body = metrics.expose();
    } catch {
      res.statusCode = 500;
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      ok();
    });
  });
  return server;
}
