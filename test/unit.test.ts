import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { avanceFromOrg, countWords, orgProse, validateAvance } from "../src/avance.js";
import { loadConfig, parseS3Url } from "../src/config.js";
import { diffSeq, hunks, locateChapters, sentences } from "../src/diff.js";
import { Notifier } from "../src/notify/notify.js";
import { extractPdf, joinTextItems, looksLikePdf, PdfError } from "../src/pdf/extract.js";
import type { ThreadOut } from "../src/repo.js";
import { safeEqual } from "../src/server/crypto.js";
import { ipBucket, RateLimiter } from "../src/server/ratelimit.js";
import { localDayHour } from "../src/server/main.js";
import { s3Store } from "../src/storage.js";
import { cleanText, esc, renderComment } from "../src/text.js";
import { fmtThread } from "../src/format.js";
import { sampleAvance, sampleThesis } from "./fixtures/make-pdf.mjs";

describe("avance.json", () => {
  it("accepts the documented schema and drops unknown keys", () => {
    const a = validateAvance({ ...sampleAvance(), extra: 1 });
    expect(a.chapters).toHaveLength(3);
    expect("extra" in a).toBe(false);
  });
  it.each([
    [{ ...sampleAvance(), schema: 2 }, /schema/],
    [{ ...sampleAvance(), title: "" }, /title/],
    [{ ...sampleAvance(), generated_at: "ayer" }, /generated_at/],
    [{ ...sampleAvance(), total_words: -1 }, /total_words/],
    [{ ...sampleAvance(), chapters: [{ id: "../x", title: "a", words: 1 }] }, /id/],
    [{ ...sampleAvance(), chapters: [{ id: "a", title: "a", words: 1, status: "listo" }] }, /status/],
    [{ ...sampleAvance(), chapters: [{ id: "a", title: "a", words: 1, goal: 0 }] }, /goal/],
    [[], /object/],
  ])("rejects %j", (input, msg) => {
    expect(() => validateAvance(input)).toThrow(msg);
  });

  it("counts words of org prose without markup, comments or drawers", () => {
    const src = `* Introducción
:PROPERTIES:
:CUSTOM_ID: cap-intro
:END:
# un comentario que no cuenta
Un \\gls{LLM} *local* genera recomendaciones [cite:@example2024routes].
#+begin_comment
nada de esto cuenta
#+end_comment
Ver [[https://example.com][el sitio]].`;
    const prose = orgProse(src);
    expect(prose).not.toContain("CUSTOM_ID");
    expect(prose).not.toContain("comentario");
    expect(prose).not.toContain("cite");
    expect(countWords(prose)).toBe(9); // Introducción Un LLM local genera recomendaciones Ver el sitio
  });

  it("builds avance.json from tesis.org includes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "avance-"));
    await mkdir(join(dir, "capitulos"));
    await writeFile(join(dir, "tesis.org"), '#+TITLE: Mi tesis\n#+INCLUDE: "capitulos/01-introduccion.org" :minlevel 1\n#+INCLUDE: "capitulos/02-marco.org" :minlevel 1\n');
    await writeFile(join(dir, "capitulos/01-introduccion.org"), "#+AVANCE_META: 3000\n#+AVANCE_ESTADO: revision\n* Introducción\nUna dos tres.\n");
    await writeFile(join(dir, "capitulos/02-marco.org"), "* Marco teórico :noexport:\nCuatro cinco.\n");
    const a = await avanceFromOrg(join(dir, "tesis.org"), new Date("2026-10-24T00:00:00Z"));
    expect(a).toEqual({
      schema: 1,
      title: "Mi tesis",
      generated_at: "2026-10-24T00:00:00.000Z",
      total_words: 8,
      chapters: [
        { id: "01-introduccion", title: "Introducción", words: 4, goal: 3000, status: "revision" },
        { id: "02-marco", title: "Marco teórico", words: 4, goal: null, status: null },
      ],
    });
  });
});

describe("output encoding", () => {
  it("escapes HTML", () => {
    expect(esc(`<a href="x" onclick='y'>&\``)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
  });
  it("renders the comment subset safely", () => {
    const h = renderComment("**negrita** y *cursiva* con `código <b>`\n\nver https://example.com/a?b=1&c=2. <img src=x onerror=alert(1)>");
    expect(h).toContain("<strong>negrita</strong>");
    expect(h).toContain("<em>cursiva</em>");
    expect(h).toContain("<code>código &lt;b&gt;</code>");
    expect(h).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow"');
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h).not.toMatch(/<img|<b>/);
    expect(renderComment("javascript:alert(1)")).not.toContain("<a");
    // A URL right before `code` must not swallow its placeholder.
    const glued = renderComment("ver https://example.com/a`x\"y`");
    expect(glued).toContain('<a href="https://example.com/a" rel=');
    expect(glued).toContain("<code>x&quot;y</code>");
    expect(glued).not.toMatch(/href="[^"]*<code>/);
    expect(renderComment('https://x.com/"onmouseover="alert(1)')).not.toContain('"onmouseover');
  });
});

describe("untrusted text", () => {
  const evil = "B \u001b]0;pwned\u0007 \u001b[31mred\u001b[0m \u202eevil\u2066x\u2069\u009b\r\nok\tend\u0000";
  it("cleanText removes control and bidi characters, keeps \\n and \\t", () => {
    expect(cleanText(evil)).toBe("B ]0;pwned [31mred[0m evilx\nok\tend");
    expect(cleanText("a\rb")).toBe("a\nb");
  });
  it("the CLI prints nothing a terminal would interpret", () => {
    const out = fmtThread({
      id: 1,
      version: 1,
      page: 2,
      quote: evil,
      status: "open",
      url: "https://r.example/v/1#hilo-1",
      chapter: { id: "c", title: evil },
      comments: [{ id: 1, author: { name: evil }, body: evil, created_at: "2026-10-24T10:00:00Z", deleted: false }],
    });
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(out).toContain("[31mred");
  });
  it("notifications carry the cleaned text", async () => {
    const tg: string[] = [];
    const n = new Notifier({ publicUrl: "https://r.example", thesisTitle: async () => "T", telegram: { send: async (t) => void tg.push(t) }, mailer: null, ownerEmail: "", instant: true, log: () => undefined });
    const author = { kind: "director" as const, name: evil, director_id: 1 };
    await n.commentCreated(
      { id: 7, version: 1, page: 1, anchor: "point", quote: evil, rects: [], status: "open", resolved_at: null, resolved_by: null, chapter: { id: "c", title: evil }, author, created_at: "", updated_at: "", can_resolve: false,
        comments: [{ id: 1, author, body: evil, body_html: "", created_at: "", edited_at: null, deleted: false, mine: false }] },
      1,
    );
    expect(tg[0]).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  });
});

describe("diff", () => {
  it("diffs sequences", () => {
    const ops = diffSeq(["a", "b", "c", "d"], ["a", "c", "x", "d"])!;
    expect(ops.map((o) => `${o.op}:${o.text}`)).toEqual(["eq:a", "del:b", "eq:c", "add:x", "eq:d"]);
    expect(diffSeq([], [])).toEqual([]);
    expect(diffSeq(["a"], [])).toEqual([{ op: "del", text: "a" }]);
  });
  it("gives up on huge rewrites", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(diffSeq(a, b, 100)).toBeNull();
  });
  it("groups hunks with context", () => {
    const ops = diffSeq(["1", "2", "3", "4", "5", "6", "7"], ["1", "2", "X", "4", "5", "6", "7"])!;
    expect(hunks(ops, 1)).toEqual([[{ op: "eq", text: "2" }, { op: "del", text: "3" }, { op: "add", text: "X" }, { op: "eq", text: "4" }]]);
  });
  it("splits sentences", () => {
    expect(sentences("Hola mundo. ¿Qué tal? Bien: Sí. 3 casos.")).toEqual(["Hola mundo.", "¿Qué tal?", "Bien:", "Sí.", "3 casos."]);
  });
  it("locates chapters after the table of contents", async () => {
    const { pages } = await extractPdf(sampleThesis());
    const ch = locateChapters(pages, validateAvance(sampleAvance()));
    expect(ch.map((c) => c.start_page)).toEqual([3, 4, 5]);
  });
});

describe("pdf", () => {
  it("validates magic bytes", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("<html>"))).toBe(false);
  });
  it("joins text items and undoes hyphenation", () => {
    expect(joinTextItems([{ str: "anonimiza-", hasEOL: true }, { str: "ción de  datos" }])).toBe("generación trazable de recomendaciones de rutas");
  });
  it("parses in a worker with a time limit and a heap limit", async () => {
    await expect(extractPdf(sampleThesis(), { timeoutMs: 1 })).rejects.toThrow(/tardó demasiado/);
    await expect(extractPdf(sampleThesis(), { maxHeapMb: 4 })).rejects.toThrow(/demasiada memoria/);
    await expect(extractPdf(new TextEncoder().encode("%PDF-1.4 basura"))).rejects.toBeInstanceOf(PdfError);
  });
  it("extracts text from a PDF", async () => {
    const { pageCount, pages } = await extractPdf(sampleThesis());
    expect(pageCount).toBe(5);
    expect(pages[2]).toContain("Introducción");
    expect(pages[2]).toContain("sin una revisión");
  });
});

describe("misc", () => {
  it("never logs director link paths", async () => {
    const { loggablePath } = await import("../src/server/app.js");
    expect(loggablePath("/acceso/abcdef")).toBe("/acceso/[oculto]");
    expect(loggablePath("/api/threads")).toBe("/api/threads");
  });
  it("compares secrets in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("rate limits per key and window", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.hit("a"), rl.hit("a"), rl.hit("a") > 0, rl.hit("b")]).toEqual([0, 0, true, 0]);
    t = 1001;
    expect(rl.hit("a")).toBe(0);
  });
  it("the CLI refuses a server URL without https (except this machine)", async () => {
    const { checkServerUrl, Client } = await import("../src/client.js");
    expect(checkServerUrl("https://tesis.example/")).toBe("https://tesis.example");
    expect(checkServerUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(checkServerUrl("http://127.0.0.1:8099")).toBe("http://127.0.0.1:8099");
    expect(checkServerUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
    for (const bad of ["http://tesis.example", "http://localhost.evil.example", "ftp://x", "tesis.example"]) {
      expect(() => checkServerUrl(bad), bad).toThrow(/https/);
    }
    expect(() => new Client({ url: "http://tesis.example", token: "t" })).toThrow(/https/);
  });
  it("buckets IPv6 clients per /64 and IPv4-mapped addresses as IPv4", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipBucket("?")).toBe("?");
  });
  it("keeps the limiter bounded without sweeping on every hit", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1000, () => t, 3);
    for (const k of ["a", "b", "c", "d"]) rl.hit(k);
    expect(rl.size).toBe(3); // "a", the oldest, was dropped
    expect(rl.hit("b")).toBeGreaterThan(0);
    t = 2000;
    rl.hit("e"); // one sweep: the expired windows go
    expect(rl.size).toBe(1);
  });
  it("parses config and refuses unsafe SMTP", () => {
    expect(parseS3Url("s3://bucket/a/b/")).toEqual({ bucket: "bucket", prefix: "a/b/" });
    const c = loadConfig({ SMTP_HOST: "smtp.protonmail.ch", SMTP_USER: "tesis@lalohao.mx", SMTP_PASSWORD: "x" });
    expect(c.smtp).toMatchObject({ port: 587, security: "starttls", from: "tesis@lalohao.mx" });
    expect(() => loadConfig({ SMTP_HOST: "smtp.example.com", SMTP_SECURITY: "none", SMTP_FROM: "a@b.c" })).toThrow(/local/);
    expect(() => loadConfig({ OWNER_TOKEN_SHA256: "abc" })).toThrow(/64 hex/);
    expect(loadConfig({}).telegram).toBeNull();
  });
  it("with MIGRATE_ON_START=false the server refuses to start on a database with pending migrations", async () => {
    const { startServer } = await import("../src/server/main.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "rt-migrate-"));
    try {
      const env = { PORT: "0", HOST: "127.0.0.1", DATABASE_URL: `pglite:${dir}/db`, STORAGE_DIR: join(dir, "f"), MIGRATE_ON_START: "false" };
      await expect(startServer(loadConfig(env), { mailer: null, telegram: null, log: () => undefined })).rejects.toThrow(/pending migrations: 001_initial/);
      const { migrate, openDb, pendingMigrations } = await import("../src/db/db.js");
      const db = await openDb(`pglite:${dir}/db`);
      await migrate(db);
      expect(await pendingMigrations(db)).toEqual([]);
      await db.close();
      const s = await startServer(loadConfig(env), { mailer: null, telegram: null, log: () => undefined });
      await s.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("computes the local day and hour", () => {
    expect(localDayHour(new Date("2026-10-24T05:30:00Z"), "America/Mexico_City")).toEqual({ day: "2026-10-23", hour: 23 });
  });
  it("signs S3 requests without touching the network", async () => {
    const seen: Request[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      seen.push(input as Request);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const store = s3Store(
      { type: "s3", bucket: "b", prefix: "p/", endpoint: "https://acct.r2.example", region: "auto", accessKeyId: "AK", secretAccessKey: "SK" },
      fake,
    );
    await store.put("pdf/abc.pdf", new Uint8Array([1, 2]), "application/pdf");
    expect(seen[0]!.url).toBe("https://acct.r2.example/b/p/pdf/abc.pdf");
    expect(seen[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
    await expect(store.put("../x", new Uint8Array(), "x")).rejects.toThrow(/invalid/);
  });
});

describe("notifications", () => {
  const thread: ThreadOut = {
    id: 7,
    version: 2,
    page: 12,
    anchor: "text",
    quote: "una cita",
    rects: [],
    status: "open",
    resolved_at: null,
    resolved_by: null,
    chapter: { id: "01-introduccion", title: "Introducción" },
    author: { kind: "director", name: "Dr. A", director_id: 1 },
    created_at: "2026-10-24T10:00:00Z",
    updated_at: "2026-10-24T10:00:00Z",
    can_resolve: false,
    comments: [
      { id: 1, author: { kind: "director", name: "Dr. A", director_id: 1 }, body: "Revise esto.", body_html: "", created_at: "2026-10-24T10:00:00Z", edited_at: null, deleted: false, mine: false },
    ],
  };
  const make = (instant = true) => {
    const tg: string[] = [];
    const mails: { to: string; subject: string; text: string }[] = [];
    const n = new Notifier({
      publicUrl: "https://r.example",
      thesisTitle: async () => "T",
      telegram: { send: async (t) => void tg.push(t) },
      mailer: { send: async (m) => void mails.push(m) },
      ownerEmail: "me@example.test",
      instant,
      log: () => undefined,
    });
    return { n, tg, mails };
  };
  it("notifies the owner on both channels with a link", async () => {
    const { n, tg, mails } = make();
    await n.commentCreated(thread, 1);
    expect(tg[0]).toContain("https://r.example/v/2#hilo-7");
    expect(tg[0]).toContain("página 12");
    expect(mails[0]).toMatchObject({ to: "me@example.test" });
  });
  it("can be limited to the digest", async () => {
    const { n, tg } = make(false);
    await n.commentCreated(thread, 1);
    expect(tg).toEqual([]);
    expect(await n.digest([thread], new Date("2026-10-24T00:00:00Z"))).toBe("sent");
    expect(tg[0]).toContain("Resumen diario: 1 comentario");
    expect(await n.digest([thread], new Date("2026-10-25T00:00:00Z"))).toBe("empty");
  });
  it("a failing channel doesn't stop the other", async () => {
    const mails: unknown[] = [];
    const logs: string[] = [];
    const n = new Notifier({
      publicUrl: "https://r.example",
      thesisTitle: async () => "T",
      telegram: { send: async () => { throw new Error("HTTP 500"); } },
      mailer: { send: async (m) => void mails.push(m) },
      ownerEmail: "me@example.test",
      instant: true,
      log: (m) => void logs.push(m),
    });
    await n.commentCreated(thread, 1);
    expect(mails).toHaveLength(1);
    expect(logs[0]).toContain("HTTP 500");
  });
});
