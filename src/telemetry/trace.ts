// A minimal tracer with an OTLP/HTTP JSON exporter (no OpenTelemetry SDK: the
// project keeps its dependencies few). Spans follow the OTLP data model; the
// active span lives in AsyncLocalStorage (scope.ts). With tracing off every
// call is a no-op that just runs the code.
//
// Export: batched (every 5 s or 512 spans), a bounded queue (2048; spans past it
// are dropped), one request at a time with a 10 s timeout. Failures are logged
// at most once a minute and never reach the app.

import { randomBytes } from "node:crypto";
import { sanitizeError, sanitizeText } from "./sanitize.js";
import { currentScope, withScope } from "./scope.js";

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | undefined | null>;

/** OTLP SpanKind values. */
export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3 } as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/** OTLP status codes. */
export const StatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
export type StatusCodeValue = (typeof StatusCode)[keyof typeof StatusCode];

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export interface SpanEvent {
  name: string;
  timeNs: bigint;
  attributes: Record<string, AttrValue>;
}

// Wall clock in nanoseconds with hrtime resolution.
const epochOffsetNs = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
export const nowNs = (): bigint => epochOffsetNs + process.hrtime.bigint();

const hex = (bytes: number) => {
  let s: string;
  do s = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(s));
  return s;
};

export class Span {
  readonly attributes: Record<string, AttrValue> = {};
  readonly events: SpanEvent[] = [];
  status: { code: StatusCodeValue; message?: string } = { code: StatusCode.UNSET };
  endNs: bigint | null = null;

  constructor(
    private readonly sink: ((s: Span) => void) | null,
    public name: string,
    readonly kind: SpanKindValue,
    readonly ctx: SpanContext,
    readonly parentSpanId: string | undefined,
    readonly startNs: bigint = nowNs(),
  ) {}

  /** Exported when it ends (tracing on and sampled). */
  get recording(): boolean {
    return this.sink !== null && this.ctx.sampled;
  }

  setAttribute(key: string, value: AttrValue | undefined | null): this {
    if (this.recording && value !== undefined && value !== null) this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Attrs): this {
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    return this;
  }

  setStatus(code: StatusCodeValue, message?: string): this {
    if (this.recording) this.status = message ? { code, message: sanitizeText(message, 500) } : { code };
    return this;
  }

  /** An `exception` event (semantic conventions), scrubbed. */
  recordException(e: unknown): this {
    if (!this.recording) return this;
    const s = sanitizeError(e);
    this.events.push({
      name: "exception",
      timeNs: nowNs(),
      attributes: { "exception.type": s.type, "exception.message": s.message, "exception.stacktrace": s.stack },
    });
    return this;
  }

  end(): void {
    if (this.endNs !== null) return;
    this.endNs = nowNs();
    if (this.recording) this.sink!(this);
  }
}

/** W3C traceparent → the remote parent; null unless strictly well-formed. */
export function parseTraceparent(header: unknown): SpanContext | null {
  if (typeof header !== "string" || header.length > 256) return null;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-[^\s]*)?$/.exec(header.trim());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m;
  if (version === "ff") return null;
  if (version === "00" && rest !== undefined) return null;
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return null;
  return { traceId: traceId!, spanId: spanId!, sampled: (parseInt(flags!, 16) & 1) === 1 };
}

export interface StartOptions {
  kind?: SpanKindValue;
  attributes?: Attrs;
  /** A remote parent (traceparent); default: the active span. */
  parent?: SpanContext | null;
  /** Only create the span inside an active trace (database queries, storage…). */
  childOnly?: boolean;
}

export interface SpanExporter {
  onEnd(span: Span): void;
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export class Tracer {
  constructor(
    private readonly exporter: SpanExporter | null,
    private readonly sampleRatio = 1,
    private readonly random: () => number = Math.random,
  ) {}

  get enabled(): boolean {
    return this.exporter !== null;
  }

  active(): Span | null {
    return currentScope()?.span ?? null;
  }

  /** A new span (not made active); null when tracing is off or childOnly without a parent. */
  startSpan(name: string, o: StartOptions = {}): Span | null {
    if (!this.exporter) return null;
    const parent = o.parent !== undefined ? o.parent : (this.active()?.ctx ?? null);
    if (!parent && o.childOnly) return null;
    const ctx: SpanContext = parent
      ? { traceId: parent.traceId, spanId: hex(8), sampled: parent.sampled }
      : { traceId: hex(16), spanId: hex(8), sampled: this.random() < this.sampleRatio };
    const span = new Span((s) => this.exporter!.onEnd(s), name, o.kind ?? SpanKind.INTERNAL, ctx, parent?.spanId);
    if (o.attributes) span.setAttributes(o.attributes);
    return span;
  }

  /**
   * Runs fn inside a new active span, ended when fn settles; an error is
   * recorded (status ERROR) and rethrown. Tracing off: just fn(null).
   */
  async withSpan<T>(name: string, o: StartOptions, fn: (span: Span | null) => Promise<T> | T): Promise<T> {
    const span = this.startSpan(name, o);
    if (!span) return fn(null);
    try {
      return await withScope({ span }, () => fn(span));
    } catch (e) {
      span.recordException(e).setStatus(StatusCode.ERROR, sanitizeError(e).message);
      throw e;
    } finally {
      span.end();
    }
  }

  flush(): Promise<void> {
    return this.exporter?.flush() ?? Promise.resolve();
  }

  shutdown(timeoutMs?: number): Promise<void> {
    return this.exporter?.shutdown(timeoutMs) ?? Promise.resolve();
  }
}

// ---- OTLP JSON encoding (protobuf JSON mapping: ids as hex, 64-bit ints as strings)

export type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export interface OtlpKeyValue {
  key: string;
  value: OtlpValue;
}

export function otlpValue(v: AttrValue): OtlpValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

export const otlpAttributes = (a: Record<string, AttrValue>): OtlpKeyValue[] =>
  Object.entries(a).map(([key, v]) => ({ key, value: otlpValue(v) }));

export interface Resource {
  attributes: Record<string, AttrValue>;
  scope: { name: string; version: string };
}

export function encodeSpans(spans: Span[], resource: Resource): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttributes(resource.attributes) },
        scopeSpans: [
          {
            scope: { name: resource.scope.name, version: resource.scope.version },
            spans: spans.map((s) => ({
              traceId: s.ctx.traceId,
              spanId: s.ctx.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: (s.endNs ?? s.startNs).toString(),
              attributes: otlpAttributes(s.attributes),
              events: s.events.map((e) => ({ timeUnixNano: e.timeNs.toString(), name: e.name, attributes: otlpAttributes(e.attributes) })),
              status: s.status.message ? { code: s.status.code, message: s.status.message } : { code: s.status.code },
            })),
          },
        ],
      },
    ],
  };
}

// ---- Batching exporter

export interface OtlpExporterOptions {
  /** The traces endpoint (…/v1/traces). */
  url: string;
  /** OTEL_EXPORTER_OTLP_HEADERS (auth); never logged. */
  headers?: Record<string, string>;
  resource: Resource;
  maxQueue?: number;
  maxBatch?: number;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called (rate-limited) when an export fails or spans are dropped. */
  onError?: (msg: string) => void;
  /** Minimum time between two onError calls (default 60 s). */
  errorEveryMs?: number;
}

export class OtlpHttpExporter implements SpanExporter {
  private queue: Span[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null;
  private lastError = -Infinity;
  private failuresSinceLog = 0;
  private droppedSinceLog = 0;
  dropped = 0;
  exported = 0;
  failures = 0;
  private closed = false;

  constructor(private readonly o: OtlpExporterOptions) {
    this.timer = setInterval(() => void this.flush(), o.intervalMs ?? 5000);
    this.timer.unref();
  }

  get queued(): number {
    return this.queue.length;
  }

  onEnd(span: Span): void {
    if (this.closed) return;
    if (this.queue.length >= (this.o.maxQueue ?? 2048)) {
      this.dropped++;
      if (!this.report("trace queue full: spans dropped")) this.droppedSinceLog++;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= (this.o.maxBatch ?? 512)) void this.flush();
  }

  /** Sends everything queued, a batch at a time; never rejects. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  async shutdown(timeoutMs = 2000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const done = this.flush();
    this.closed = true;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise<void>((ok) => (t = setTimeout(ok, timeoutMs)))]);
    clearTimeout(t);
  }

  private async drain(): Promise<void> {
    const max = this.o.maxBatch ?? 512;
    while (this.queue.length) {
      const batch = this.queue.splice(0, max);
      await this.send(batch);
    }
  }

  private async send(batch: Span[]): Promise<void> {
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url, {
        method: "POST",
        headers: { ...this.o.headers, "content-type": "application/json" },
        body: JSON.stringify(encodeSpans(batch, this.o.resource)),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.exported += batch.length;
    } catch (e) {
      this.failures++;
      if (!this.report(`trace export failed: ${sanitizeError(e).message}`)) this.failuresSinceLog++;
    }
  }

  /** Reports a problem unless one was reported in the last minute; false if suppressed. */
  private report(msg: string): boolean {
    const now = Date.now();
    if (now - this.lastError < (this.o.errorEveryMs ?? 60_000)) return false;
    this.lastError = now;
    const extra = [
      this.failuresSinceLog ? `${this.failuresSinceLog} more failed exports` : null,
      this.droppedSinceLog ? `${this.droppedSinceLog} more spans dropped` : null,
    ].filter(Boolean);
    this.failuresSinceLog = 0;
    this.droppedSinceLog = 0;
    try {
      this.o.onError?.(extra.length ? `${msg} (${extra.join(", ")} since the last report)` : msg);
    } catch {
      // A logger failure must not break exports either.
    }
    return true;
  }
}
