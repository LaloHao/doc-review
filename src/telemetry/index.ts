// Optional telemetry: structured logs (LOG_FORMAT, LOG_LEVEL, LOG_IDENTITIES),
// traces over OTLP/HTTP JSON (OTEL_EXPORTER_OTLP_ENDPOINT) and Prometheus
// metrics on a separate port (METRICS_PORT). Everything is off by default:
// without those variables nothing is sent anywhere and the logs look as they
// always did.
//
// Privacy: spans and metrics never carry tokens, link secrets, raw paths,
// cookies, headers, names, emails, comment text, PDF content or IP addresses;
// they get route patterns, status codes, roles, slugs and numeric ids. Log lines
// follow the same rules unless the operator turns on LOG_IDENTITIES, which adds
// who made each request (still never a token, cookie, secret path or text).

import { hostname } from "node:os";
import type { TelemetryConfig } from "../config.js";
import { APP_VERSION } from "../version.js";
import { createLogger, type Logger } from "./log.js";
import { createMetrics, NOOP_METRICS, type AppMetrics } from "./metrics.js";
import { OtlpHttpExporter, Tracer, type AttrValue } from "./trace.js";

export type { Logger } from "./log.js";
export type { AppMetrics } from "./metrics.js";
export { SpanKind, StatusCode, type Span, type Tracer } from "./trace.js";

export interface Telemetry {
  log: Logger;
  tracer: Tracer;
  metrics: AppMetrics;
  config: TelemetryConfig;
  /** A request scope is worth setting up (tracing or identities on). */
  readonly scoped: boolean;
  /** Flushes pending spans (short timeout) and stops the timers. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export const TELEMETRY_OFF: TelemetryConfig = { logFormat: "text", logLevel: "info", logIdentities: false, traces: null, metricsPort: null };

export interface TelemetryOptions {
  /** Where log lines go (default stdout). */
  sink?: (line: string) => void;
  fetch?: typeof fetch;
  /** Export tuning (tests). */
  exporter?: { intervalMs?: number; maxBatch?: number; maxQueue?: number; timeoutMs?: number; errorEveryMs?: number };
}

export function createTelemetry(config: TelemetryConfig = TELEMETRY_OFF, o: TelemetryOptions = {}): Telemetry {
  const log = createLogger({ format: config.logFormat, level: config.logLevel, identities: config.logIdentities, sink: o.sink });
  let tracer = new Tracer(null);
  let exporter: OtlpHttpExporter | null = null;
  if (config.traces) {
    const t = config.traces;
    const attributes: Record<string, AttrValue> = {
      ...t.resourceAttributes,
      "service.name": t.serviceName,
      "service.version": APP_VERSION,
      "telemetry.sdk.name": "doc-review",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.version": APP_VERSION,
      "process.runtime.name": "nodejs",
      "process.runtime.version": process.versions.node,
    };
    if (!("service.instance.id" in attributes)) attributes["service.instance.id"] = hostname();
    exporter = new OtlpHttpExporter({
      url: t.url,
      headers: t.headers,
      resource: { attributes, scope: { name: "doc-review", version: APP_VERSION } },
      fetch: o.fetch,
      ...o.exporter,
      onError: (msg) => log.warn("telemetry_export_failed", msg),
    });
    tracer = new Tracer(exporter, t.sampleRatio);
  }
  const metrics = config.metricsPort !== null ? createMetrics(APP_VERSION) : NOOP_METRICS;
  return {
    log,
    tracer,
    metrics,
    config,
    scoped: tracer.enabled || config.logIdentities,
    async shutdown(timeoutMs = 2000) {
      metrics.close();
      await exporter?.shutdown(timeoutMs);
    },
  };
}
