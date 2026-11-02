// Optional telemetry: JSON logs, OTLP traces (to a fake collector on
// localhost) and Prometheus metrics. Nothing here uses the network.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeConfig, loadConfig, loadTelemetryConfig, parseKeyValues } from "../src/config.js";
import { createTelemetry } from "../src/telemetry/index.js";
import { sqlOperation } from "../src/telemetry/instrument.js";
import { createLogger } from "../src/telemetry/log.js";
import { Counter, createMetrics, Histogram, Registry } from "../src/telemetry/metrics.js";
import { sanitizeText } from "../src/telemetry/sanitize.js";
import { withScope } from "../src/telemetry/scope.js";
import { encodeSpans, OtlpHttpExporter, parseTraceparent, Span, SpanKind, StatusCode, Tracer } from "../src/telemetry/trace.js";
import { OWNER_TOKEN, settle, startTestServer, type TestServer } from "./helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

interface Collector {
  url: string;
  bodies: Json[];
  headers: IncomingHttpHeaders[];
  spans(): Json[];
  close(): Promise<void>;
}

/** A fake OTLP/HTTP collector on localhost. */
async function collector(status = 200): Promise<Collector> {
  const bodies: Json[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url === "/v1/traces") {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json);
      headers.push(req.headers);
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    headers,
    spans: () => bodies.flatMap((b) => (b.resourceSpans as Json[]).flatMap((r) => (r.scopeSpans as Json[]).flatMap((s) => s.spans as Json[]))),
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const attr = (span: Json, key: string): unknown => {
  const v = (span.attributes as Json[]).find((a) => a.key === key)?.value as Json | undefined;
  return v ? (v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue) : undefined;
};

const point = (body: string) => ({ version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body });

const REVIEWER = { name: "Dr. Jane Roe", email: "jane.roe@example.test" };
const COMMENT = "A private remark about chapter two";

/** A document with a version and a reviewer who opened their link and commented. */
async function scenario(s: TestServer, headers: Record<string, string> = {}) {
  await s.createDoc("thesis");
  expect((await s.publish("thesis")).status).toBe(201);
  const inv = await s.invite("thesis", REVIEWER);
  const secret = new URL(inv.link).pathname.split("/").pop()!;
  const b = await s.browser();
  await b.get(new URL(inv.link).pathname, headers);
  await b.login();
  const res = await b.send("POST", "/api/documents/thesis/threads", point(COMMENT), headers);
  expect(res.status).toBe(201);
  const { thread } = (await res.json()) as { thread: { id: number } };
  expect((await b.send("POST", `/api/threads/${thread.id}/comments`, { body: "And a reply" }, headers)).status).toBe(201);
  await settle();
  return { inv, secret, b, threadId: thread.id };
}

const servers: TestServer[] = [];
const collectors: Collector[] = [];
const start = async (env: Record<string, string> = {}) => {
  const s = await startTestServer(env);
  servers.push(s);
  return s;
};
afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length) await servers.pop()!.stop();
  while (collectors.length) await collectors.pop()!.close();
});

describe("configuration", () => {
  it("everything is off by default", () => {
    expect(loadTelemetryConfig({})).toEqual({ logFormat: "text", logLevel: "info", logIdentities: false, traces: null, metricsPort: null });
  });
  it("reads the standard OTel variables", () => {
    const t = loadTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy.monitoring.svc.cluster.local:4318/",
      OTEL_SERVICE_NAME: "review",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,team=me%20too",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc,x-scope-orgid=1",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
    });
    expect(t.traces).toEqual({
      url: "http://alloy.monitoring.svc.cluster.local:4318/v1/traces",
      headers: { authorization: "Bearer abc", "x-scope-orgid": "1" },
      serviceName: "review",
      resourceAttributes: { "deployment.environment": "prod", team: "me too" },
      sampleRatio: 0.25,
    });
    expect(loadTelemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://x.example/otlp/traces" }).traces?.url).toBe("https://x.example/otlp/traces");
    expect(loadTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318", OTEL_SDK_DISABLED: "true" }).traces).toBeNull();
    expect(() => loadTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318", OTEL_TRACES_SAMPLER_ARG: "2" })).toThrow(/SAMPLER_ARG/);
    expect(() => loadTelemetryConfig({ LOG_FORMAT: "xml" })).toThrow(/LOG_FORMAT/);
    expect(() => loadTelemetryConfig({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
    expect(loadTelemetryConfig({ METRICS_PORT: "9464" }).metricsPort).toBe(9464);
  });
  it("never puts header values in errors", () => {
    expect(() => parseKeyValues("supersecret", "OTEL_EXPORTER_OTLP_HEADERS")).toThrow(/key=value/);
    try {
      parseKeyValues("supersecret", "OTEL_EXPORTER_OTLP_HEADERS");
    } catch (e) {
      expect((e as Error).message).not.toContain("supersecret");
    }
  });
  it("the startup summary is unchanged without telemetry and never shows headers", () => {
    const base = { PUBLIC_URL: "https://r.example", DATABASE_URL: "pglite:memory" };
    const plain = loadConfig(base);
    expect(createTelemetry(plain.telemetry).tracer.enabled).toBe(false);
    const on = loadConfig({ ...base, LOG_FORMAT: "json", LOG_IDENTITIES: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:pw@alloy:4318", OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer s3cr3t", METRICS_PORT: "9464" });
    expect(describeConfig(plain)).not.toMatch(/logs|traces|metrics|identities/);
    const d = describeConfig(on);
    expect(d).toContain("logs json");
    expect(d).toContain("identities logged");
    expect(d).toContain("traces on (alloy:4318");
    expect(d).toContain("metrics on :9464");
    expect(d).not.toMatch(/s3cr3t|pw@|user:/);
  });
});

describe("sanitizing", () => {
  it("masks link paths, tokens, credentials and addresses", () => {
    const s = sanitizeText(
      "GET https://r.example/a/AbCdEfGhIjKlMnOp failed for jane@example.org with Bearer xyz.123 and dr_owner_abcdef; postgres://app:hunter2@db/x; bot123:AAbbCC",
    );
    expect(s).toBe("GET https://r.example/a/[hidden] failed for [email] with Bearer [hidden] and dr_owner_[hidden]; postgres://[hidden]@db/x; bot[hidden]");
  });
});

describe("traceparent", () => {
  const id = "4bf92f3577b34da6a3ce929d0e0e4736";
  const parent = "00f067aa0ba902b7";
  it("accepts a well-formed header", () => {
    expect(parseTraceparent(`00-${id}-${parent}-01`)).toEqual({ traceId: id, spanId: parent, sampled: true });
    expect(parseTraceparent(`00-${id}-${parent}-00`)).toEqual({ traceId: id, spanId: parent, sampled: false });
    // A future version may append fields.
    expect(parseTraceparent(`01-${id}-${parent}-01-extra`)).toMatchObject({ traceId: id });
  });
  it("rejects anything else", () => {
    for (const h of [
      undefined,
      ["a", "b"],
      "",
      `00-${id}-${parent}`,
      `00-${id.toUpperCase()}-${parent}-01`,
      `00-${"0".repeat(32)}-${parent}-01`,
      `00-${id}-${"0".repeat(16)}-01`,
      `ff-${id}-${parent}-01`,
      `00-${id}-${parent}-01-extra`,
      `0-${id}-${parent}-01`,
      `00-${id}x-${parent}-01`,
      `00-${id}-${parent}-1`,
    ]) {
      expect(parseTraceparent(h)).toBeNull();
    }
  });
});

describe("OTLP JSON encoding", () => {
  it("follows the protobuf JSON mapping", () => {
    const ended: Span[] = [];
    const span = new Span((s) => ended.push(s), "GET /api/threads/:id", SpanKind.SERVER, { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true }, "c".repeat(16), 1_700_000_000_000_000_000n);
    span.setAttributes({ "http.request.method": "GET", "http.response.status_code": 200, ok: true, ratio: 0.5, nothing: undefined });
    span.recordException(new TypeError("boom at /a/SECRETSECRETSECRET"));
    span.setStatus(StatusCode.ERROR, "boom");
    span.endNs = 1_700_000_000_250_000_000n;
    const body = encodeSpans([span], { attributes: { "service.name": "doc-review" }, scope: { name: "doc-review", version: "1.2.3" } }) as Json;
    const exc = body.resourceSpans[0].scopeSpans[0].spans[0].events[0];
    expect(exc.name).toBe("exception");
    expect(JSON.stringify(exc)).not.toContain("SECRET");
    expect(body).toEqual({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "doc-review" } }] },
          scopeSpans: [
            {
              scope: { name: "doc-review", version: "1.2.3" },
              spans: [
                {
                  traceId: "a".repeat(32),
                  spanId: "b".repeat(16),
                  parentSpanId: "c".repeat(16),
                  name: "GET /api/threads/:id",
                  kind: 2,
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000250000000",
                  attributes: [
                    { key: "http.request.method", value: { stringValue: "GET" } },
                    { key: "http.response.status_code", value: { intValue: "200" } },
                    { key: "ok", value: { boolValue: true } },
                    { key: "ratio", value: { doubleValue: 0.5 } },
                  ],
                  events: [
                    {
                      timeUnixNano: exc.timeUnixNano,
                      name: "exception",
                      attributes: [
                        { key: "exception.type", value: { stringValue: "TypeError" } },
                        { key: "exception.message", value: { stringValue: "boom at /a/[hidden]" } },
                        { key: "exception.stacktrace", value: { stringValue: expect.stringContaining("TypeError: boom at /a/[hidden]") } },
                      ],
                    },
                  ],
                  status: { code: 2, message: "boom" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(exc.timeUnixNano).toMatch(/^\d{19}$/);
  });
  it("a root span has no parentSpanId; children share the trace", async () => {
    const ended: Span[] = [];
    const tracer = new Tracer({ onEnd: (s) => ended.push(s), flush: async () => undefined, shutdown: async () => undefined });
    await tracer.withSpan("root", {}, async () => {
      await tracer.withSpan("child", { kind: SpanKind.CLIENT }, async () => undefined);
    });
    const [child, root] = ended;
    expect(root!.parentSpanId).toBeUndefined();
    expect(child!.parentSpanId).toBe(root!.ctx.spanId);
    expect(child!.ctx.traceId).toBe(root!.ctx.traceId);
    expect(root!.ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root!.ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    // childOnly spans need a trace to join.
    expect(tracer.startSpan("orphan", { childOnly: true })).toBeNull();
  });
  it("records the error and rethrows it", async () => {
    const ended: Span[] = [];
    const tracer = new Tracer({ onEnd: (s) => ended.push(s), flush: async () => undefined, shutdown: async () => undefined });
    await expect(tracer.withSpan("x", {}, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(ended[0]!.status.code).toBe(StatusCode.ERROR);
    expect(ended[0]!.events[0]!.name).toBe("exception");
  });
  it("samples by ratio; unsampled spans are not exported", async () => {
    const ended: Span[] = [];
    const tracer = new Tracer({ onEnd: (s) => ended.push(s), flush: async () => undefined, shutdown: async () => undefined }, 0.5, () => 0.9);
    await tracer.withSpan("dropped", {}, async (span) => {
      expect(span!.recording).toBe(false);
      await tracer.withSpan("child", {}, async () => undefined);
    });
    expect(ended).toEqual([]);
  });
  it("is a no-op when off", async () => {
    const tracer = new Tracer(null);
    expect(await tracer.withSpan("x", {}, async (span) => (span === null ? "ran" : "?"))).toBe("ran");
  });
});

describe("batching exporter", () => {
  const span = (i: number) => {
    const s = new Span(null, `s${i}`, SpanKind.INTERNAL, { traceId: "a".repeat(32), spanId: i.toString(16).padStart(16, "0"), sampled: true }, undefined);
    s.endNs = s.startNs;
    return s;
  };
  const resource = { attributes: { "service.name": "t" }, scope: { name: "t", version: "0" } };

  it("batches, bounds the queue and flushes", async () => {
    const sent: number[] = [];
    const errors: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sent.push(((JSON.parse(init!.body as string) as Json).resourceSpans[0].scopeSpans[0].spans as unknown[]).length);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const ex = new OtlpHttpExporter({ url: "http://127.0.0.1:1/v1/traces", resource, fetch: fetchImpl, maxBatch: 2, maxQueue: 3, intervalMs: 3_600_000, onError: (m) => errors.push(m) });
    ex.onEnd(span(1));
    expect(sent).toEqual([]); // below the batch size: waits for the timer
    ex.onEnd(span(2)); // a full batch: sent right away
    await ex.flush();
    expect(sent).toEqual([2]);
    for (let i = 3; i < 9; i++) ex.onEnd(span(i));
    await ex.flush();
    expect(ex.exported + ex.dropped).toBe(8);
    expect(ex.queued).toBe(0);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(ex.exported);
    await ex.shutdown(100);
  });
  it("drops spans past the queue limit", async () => {
    const errors: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const fetchImpl = (async () => {
      await gate;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ex = new OtlpHttpExporter({ url: "http://127.0.0.1:1/v1/traces", resource, fetch: fetchImpl, maxBatch: 100, maxQueue: 3, intervalMs: 3_600_000, onError: (m) => errors.push(m) });
    for (let i = 1; i <= 5; i++) ex.onEnd(span(i));
    expect(ex.queued).toBe(3);
    expect(ex.dropped).toBe(2);
    expect(errors).toEqual(["trace queue full: spans dropped"]);
    const done = ex.flush();
    release();
    await done;
    expect(ex.exported).toBe(3);
    await ex.shutdown(100);
  });
  it("failures never throw and are reported at most once a minute", async () => {
    const errors: string[] = [];
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED to http://user:pw@collector");
    }) as unknown as typeof fetch;
    const ex = new OtlpHttpExporter({ url: "http://127.0.0.1:1/v1/traces", resource, fetch: fetchImpl, intervalMs: 3_600_000, onError: (m) => errors.push(m) });
    for (let i = 0; i < 3; i++) {
      ex.onEnd(span(i));
      await expect(ex.flush()).resolves.toBeUndefined();
    }
    expect(ex.failures).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^trace export failed: connect ECONNREFUSED/);
    expect(errors[0]).not.toContain("pw");
    await ex.shutdown(100);
  });
  it("a collector that answers 500, or never, doesn't hold anything up", async () => {
    const c = await collector(500);
    collectors.push(c);
    const errors: string[] = [];
    const ex = new OtlpHttpExporter({ url: `${c.url}/v1/traces`, resource, intervalMs: 3_600_000, onError: (m) => errors.push(m) });
    ex.onEnd(span(1));
    await ex.flush();
    expect(errors[0]).toBe("trace export failed: HTTP 500");
    await ex.shutdown(100);

    const hang = createServer(() => undefined); // never answers
    await new Promise<void>((ok) => hang.listen(0, "127.0.0.1", ok));
    const port = (hang.address() as { port: number }).port;
    const ex2 = new OtlpHttpExporter({ url: `http://127.0.0.1:${port}/v1/traces`, resource, intervalMs: 3_600_000, timeoutMs: 200, onError: (m) => errors.push(m) });
    ex2.onEnd(span(2));
    const t0 = Date.now();
    await ex2.shutdown(1000);
    expect(Date.now() - t0).toBeLessThan(1500);
    hang.closeAllConnections();
    await new Promise<void>((ok) => hang.close(() => ok()));
  });
});

describe("logger", () => {
  it("text: the message alone; telemetry-era events only at debug", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    log.info("x", "person #3 created", { person_id: 3 });
    log.info("http_request", "GET / 200 1ms", {}, { quietText: true });
    log.warn("y", "owner login failed", {}, { text: "owner login failed from 192.0.2.1" });
    expect(lines).toEqual(["person #3 created", "owner login failed from 192.0.2.1"]);
  });
  it("json: one object per line, with the trace inside a span", async () => {
    const lines: string[] = [];
    const log = createLogger({ format: "json", sink: (l) => lines.push(l), now: () => new Date("2026-11-02T10:00:00Z") });
    const tracer = new Tracer({ onEnd: () => undefined, flush: async () => undefined, shutdown: async () => undefined });
    log.debug("hidden", "below the level");
    let ids = { traceId: "", spanId: "" };
    await tracer.withSpan("req", {}, async (span) => {
      ids = span!.ctx;
      log.error("boom", "it failed", { route: "/a/:secret", count: 2, gone: undefined }, { error: new Error("token dr_owner_abc leaked") });
    });
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]!) as Json;
    expect(o).toMatchObject({ time: "2026-11-02T10:00:00.000Z", level: "error", event: "boom", msg: "it failed", trace_id: ids.traceId, span_id: ids.spanId, route: "/a/:secret", count: 2, error_type: "Error", error_message: "token dr_owner_[hidden] leaked" });
    expect(o).not.toHaveProperty("gone");
    expect(o.error_stack).not.toContain("dr_owner_abc");
  });
  it("identities only when asked for", () => {
    const lines: string[] = [];
    const off = createLogger({ format: "json", sink: (l) => lines.push(l) });
    const on = createLogger({ format: "json", identities: true, sink: (l) => lines.push(l) });
    withScope({ identity: { client_ip: "203.0.113.9", person_email: "a@b.example" } }, () => {
      off.info("e", "m");
      on.info("e", "m");
    });
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("client_ip");
    expect(JSON.parse(lines[1]!)).toMatchObject({ client_ip: "203.0.113.9", person_email: "a@b.example" });
  });
});

describe("metrics exposition", () => {
  it("writes counters and cumulative histograms in the text format", () => {
    const r = new Registry();
    const c = r.register(new Counter("t_total", "A counter.", ["route"]));
    const h = r.register(new Histogram("t_seconds", "A histogram.", ["route"], [0.1, 1]));
    c.inc({ route: '/a/"x"' });
    c.inc({ route: '/a/"x"' }, 2);
    h.observe({ route: "/" }, 0.05);
    h.observe({ route: "/" }, 0.5);
    h.observe({ route: "/" }, 5);
    expect(r.expose()).toBe(
      [
        "# HELP t_total A counter.",
        "# TYPE t_total counter",
        't_total{route="/a/\\"x\\""} 3',
        "# HELP t_seconds A histogram.",
        "# TYPE t_seconds histogram",
        't_seconds_bucket{route="/",le="0.1"} 1',
        't_seconds_bucket{route="/",le="1"} 2',
        't_seconds_bucket{route="/",le="+Inf"} 3',
        't_seconds_sum{route="/"} 5.55',
        't_seconds_count{route="/"} 3',
        "",
      ].join("\n"),
    );
  });
  it("has the process basics and build info", () => {
    const m = createMetrics("9.9.9");
    const text = m.expose();
    m.close();
    for (const name of ["docreview_build_info{version=\"9.9.9\"} 1", "process_start_time_seconds ", "process_resident_memory_bytes ", "process_cpu_seconds_total ", "nodejs_eventloop_lag_seconds "]) {
      expect(text).toContain(name);
    }
  });
  it("derives the SQL operation without values", () => {
    expect(sqlOperation("select id, slug from documents where slug = $1")).toEqual({ operation: "select", table: "documents" });
    expect(sqlOperation("  insert into threads (a) values ($1)")).toEqual({ operation: "insert", table: "threads" });
    expect(sqlOperation("UPDATE sessions set x = 'secret' where id = $1")).toEqual({ operation: "update", table: "sessions" });
    expect(sqlOperation("delete from enroll_codes where expires_at < now()")).toEqual({ operation: "delete", table: "enroll_codes" });
    expect(sqlOperation("select 1")).toEqual({ operation: "select" });
    expect(sqlOperation("vacuum full")).toEqual({ operation: "other" });
  });
});

describe("the server, telemetry off (the default)", () => {
  it("sends nothing anywhere, opens no metrics port and logs as before", async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return real(input, init);
    });
    const s = await start();
    expect(s.telemetry.tracer.enabled).toBe(false);
    expect(s.telemetry.metrics.enabled).toBe(false);
    expect(s.metricsServer).toBeNull();
    expect(s.metricsUrl).toBeNull();
    await scenario(s);
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u.startsWith(s.url)).toBe(true);
    // The text format, without request lines or identities.
    expect(s.logs.some((l) => l.startsWith("{"))).toBe(false);
    expect(s.logs.some((l) => / \d+ms$/.test(l))).toBe(false);
    expect(s.logs.join("\n")).not.toContain(REVIEWER.email);
    expect(s.logs[s.logs.length - 1]).not.toBeUndefined();
    expect(s.logs.find((l) => l.startsWith("doc-review listening"))).toMatch(/digest off\)$/);
    // The public port has no /metrics.
    expect((await fetch(s.url + "/metrics")).status).toBe(404);
  });
});

describe("the server with JSON logs, traces and metrics", () => {
  it("traces requests with route patterns only, continues a traceparent and exports on close", async () => {
    const c = await collector();
    collectors.push(c);
    const s = await start({
      LOG_FORMAT: "json",
      OTEL_EXPORTER_OTLP_ENDPOINT: c.url,
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer collector-secret",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test",
    });
    const { secret, threadId } = await scenario(s);
    const parent = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await s.owner(`/api/threads/${threadId}`, { headers: { traceparent: `00-${parent}-00f067aa0ba902b7-01` } });
    expect(res.status).toBe(200);
    await settle();
    await s.telemetry.tracer.flush();

    expect(c.headers[0]!.authorization).toBe("Bearer collector-secret");
    expect(c.headers[0]!["content-type"]).toBe("application/json");
    const resource = c.bodies[0]!.resourceSpans[0].resource as Json;
    expect(attr(resource, "service.name")).toBe("doc-review");
    expect(attr(resource, "deployment.environment")).toBe("test");

    const spans = c.spans();
    const names = spans.map((x) => x.name as string);
    expect(names).toContain("GET /a/:secret");
    expect(names).toContain("POST /api/documents/:slug/threads");
    expect(names).toContain("POST /api/documents/:slug/versions");
    expect(names).toContain("pdf.extract");
    expect(names).toContain("blob.put");
    expect(names.some((n) => n.startsWith("select "))).toBe(true);
    expect(names).toContain("smtp.send");
    expect(names).toContain("telegram.sendMessage");

    const link = spans.find((x) => x.name === "GET /a/:secret")!;
    expect(link.kind).toBe(2);
    expect(attr(link, "http.route")).toBe("/a/:secret");
    expect(attr(link, "http.response.status_code")).toBe("303");
    expect(attr(link, "http.request.method")).toBe("GET");
    const post = spans.find((x) => x.name === "POST /api/documents/:slug/threads")!;
    expect(attr(post, "docreview.document.slug")).toBe("thesis");
    expect(attr(post, "docreview.role")).toBe("reviewer");
    const query = spans.find((x) => x.parentSpanId === post.spanId && x.kind === 3)!;
    expect(attr(query, "db.system")).toBe("pglite");
    expect(query.traceId).toBe(post.traceId);

    const continued = spans.find((x) => x.name === "GET /api/threads/:id")!;
    expect(continued.traceId).toBe(parent);
    expect(continued.parentSpanId).toBe("00f067aa0ba902b7");
    expect(attr(continued, "docreview.thread.id")).toBe(String(threadId));

    // Health probes aren't traced.
    await fetch(s.url + "/healthz");
    await s.telemetry.tracer.flush();
    expect(c.spans().some((x) => String(x.name).includes("healthz"))).toBe(false);

    const exported = JSON.stringify(c.bodies);
    for (const leak of [secret, OWNER_TOKEN, REVIEWER.email, REVIEWER.name, COMMENT, "And a reply", "127.0.0.1", "collector-secret", "Eduardo Ejemplo", "owner@example.test"]) {
      expect(exported).not.toContain(leak);
    }
    expect(exported).not.toMatch(/"url\.(path|full|query)"/);

    // JSON log lines; the request line carries the trace of its span.
    const lines = s.logs.map((l) => JSON.parse(l) as Json);
    for (const o of lines) {
      expect(typeof o.time).toBe("string");
      expect(["debug", "info", "warn", "error"]).toContain(o.level);
      expect(typeof o.msg).toBe("string");
      expect(typeof o.event).toBe("string");
    }
    const req = lines.find((o) => o.event === "http_request" && o.route === "/api/threads/:id")!;
    expect(req).toMatchObject({ level: "info", method: "GET", status: 200, role: "owner", thread_id: threadId, trace_id: parent, span_id: continued.spanId });
    expect(typeof req.duration_ms).toBe("number");
    expect(lines.find((o) => o.event === "http_request" && o.route === "/a/:secret")).toMatchObject({ status: 303, role: "anonymous" });
    expect(lines.some((o) => o.event === "http_request" && o.route === "/healthz")).toBe(false); // debug only
    const startup = lines.find((o) => o.event === "startup")!;
    expect(startup).toMatchObject({ traces: true, log_identities: false, traces_endpoint_host: new URL(c.url).host });
    expect(startup).not.toHaveProperty("metrics_port");
    expect(lines.find((o) => o.event === "comment_created")).toMatchObject({ role: "reviewer", doc: "thesis", thread_id: threadId });
    expect(lines.find((o) => o.event === "notification_sent")).toMatchObject({ result: "ok" });
    const logged = s.logs.join("\n");
    for (const leak of [secret, OWNER_TOKEN, REVIEWER.email, REVIEWER.name, COMMENT, "collector-secret"]) expect(logged).not.toContain(leak);
  });

  it("serves metrics on their own port", async () => {
    const s = await start({ METRICS_PORT: "0" });
    expect(s.metricsUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
    expect(new URL(s.metricsUrl!).port).not.toBe(new URL(s.url).port);
    await scenario(s);
    await s.owner("/api/documents");
    const res = await fetch(s.metricsUrl!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await res.text();
    expect(text).toContain('docreview_http_requests_total{method="GET",route="/api/documents",status="200"} 1');
    expect(text).toContain('docreview_http_requests_total{method="GET",route="/a/:secret",status="303"} 1');
    expect(text).toMatch(/docreview_http_request_duration_seconds_count\{method="POST",route="\/api\/documents\/:slug\/threads"\} 1/);
    expect(text).toContain('docreview_comments_created_total{role="reviewer"} 1');
    expect(text).toContain('docreview_replies_created_total{role="reviewer"} 1');
    expect(text).toContain("docreview_versions_published_total 1");
    expect(text).toMatch(/docreview_notifications_total\{channel="telegram",result="ok"\} \d+/);
    expect(text).toMatch(/docreview_db_query_duration_seconds_count\{operation="select"\} \d+/);
    expect(text).toContain("docreview_build_info{version=");
    expect(text).not.toContain(new URL((await s.invite("thesis", { name: "X" })).link).pathname);
    expect((await fetch(s.metricsUrl!.replace("/metrics", "/"))).status).toBe(404);
    // The public port doesn't serve them.
    expect((await fetch(s.url + "/metrics")).status).toBe(404);
  });

  it("exports nothing to a dead collector and still works", async () => {
    const s = await start({ LOG_FORMAT: "json", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" });
    await scenario(s);
    await s.telemetry.tracer.flush();
    const failures = s.logs.map((l) => JSON.parse(l) as Json).filter((o) => o.event === "telemetry_export_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.level).toBe("warn");
  });
});

describe("LOG_IDENTITIES", () => {
  const cf = { "cf-connecting-ip": "203.0.113.7", "user-agent": "TestAgent/1.0" };

  it("is off by default: no names, emails, IPs or user agents", async () => {
    const s = await start({ LOG_FORMAT: "json", TRUST_PROXY: "cloudflare" });
    const { secret } = await scenario(s, cf);
    const logged = s.logs.join("\n");
    for (const leak of [REVIEWER.email, REVIEWER.name, "203.0.113.7", "TestAgent", secret, OWNER_TOKEN, COMMENT]) expect(logged).not.toContain(leak);
    for (const o of s.logs.map((l) => JSON.parse(l) as Json)) {
      expect(o).not.toHaveProperty("client_ip");
      expect(o).not.toHaveProperty("person_email");
      expect(o).not.toHaveProperty("user_agent");
    }
  });

  it("adds who did it, never tokens, secret paths or comment text", async () => {
    const c = await collector();
    collectors.push(c);
    const s = await start({ LOG_FORMAT: "json", LOG_IDENTITIES: "true", TRUST_PROXY: "cloudflare", OTEL_EXPORTER_OTLP_ENDPOINT: c.url, METRICS_PORT: "0" });
    const { secret, inv, threadId } = await scenario(s, cf);
    // A bad link and a bad token, from the same client.
    await fetch(s.url + "/a/" + "x".repeat(43), { redirect: "manual", headers: cf });
    await fetch(s.url + "/api/me", { headers: { ...cf, authorization: "Bearer dr_owner_wrong-token-value" } });
    await settle();
    await s.telemetry.tracer.flush();

    const lines = s.logs.map((l) => JSON.parse(l) as Json);
    expect(lines.find((o) => o.event === "startup")).toMatchObject({ log_identities: true });
    const opened = lines.find((o) => o.event === "link_opened")!;
    expect(opened).toMatchObject({ person_id: inv.personId, person_name: REVIEWER.name, person_email: REVIEWER.email, invitation_id: inv.invitationId, client_ip: "203.0.113.7", user_agent: "TestAgent/1.0" });
    const comment = lines.find((o) => o.event === "comment_created")!;
    expect(comment).toMatchObject({ actor: "reviewer", person_name: REVIEWER.name, person_email: REVIEWER.email, client_ip: "203.0.113.7", thread_id: threadId, doc: "thesis", invitation_id: inv.invitationId });
    expect(lines.find((o) => o.event === "http_request" && o.route === "/api/documents/:slug/threads" && o.method === "POST")).toMatchObject({ person_email: REVIEWER.email, client_ip: "203.0.113.7" });
    expect(lines.find((o) => o.event === "link_invalid")).toMatchObject({ client_ip: "203.0.113.7" });
    expect(lines.find((o) => o.event === "bearer_rejected")).toMatchObject({ client_ip: "203.0.113.7" });
    expect(lines.find((o) => o.event === "http_request" && o.role === "owner")).toMatchObject({ actor: "owner" });

    const logged = s.logs.join("\n");
    for (const leak of [secret, OWNER_TOKEN, "dr_owner_wrong-token-value", "x".repeat(43), COMMENT, "And a reply", "__Host-dr_session"]) expect(logged).not.toContain(leak);

    // Spans and metrics stay identity-free.
    const exported = JSON.stringify(c.bodies) + (await (await fetch(s.metricsUrl!)).text());
    for (const leak of [REVIEWER.email, REVIEWER.name, "203.0.113.7", "TestAgent", secret]) expect(exported).not.toContain(leak);
  });
});
