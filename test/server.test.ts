import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleAvance, sampleThesis } from "./fixtures/make-pdf.mjs";
import { OWNER_TOKEN, settle, startTestServer, type TestServer } from "./helpers.js";

const ORIGIN = "https://revision.example.test";
let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.stop();
});

const owner = (path: string, init: RequestInit = {}) =>
  fetch(s.url + path, { ...init, headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...(init.headers ?? {}) } });

const ownerJson = (method: string, path: string, body: unknown) =>
  owner(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

function publishForm(pdf: Uint8Array, avance: unknown, note = "") {
  const f = new FormData();
  f.set("pdf", new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), "tesis.pdf");
  f.set("avance", new Blob([JSON.stringify(avance)], { type: "application/json" }), "avance.json");
  f.set("note", note);
  return f;
}

/** A browser: keeps the session cookie, sends Origin and the CSRF token like viewer.js. */
class Browser {
  cookie = "";
  csrf = "";
  async get(path: string) {
    const res = await fetch(s.url + path, { redirect: "manual", headers: this.cookie ? { cookie: this.cookie } : {} });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(";");
      if (pair!.startsWith("__Host-rt_session=")) this.cookie = pair!.endsWith("=") ? "" : pair!;
    }
    return res;
  }
  async login() {
    const me = await this.get("/api/me");
    this.csrf = ((await me.json()) as { csrf: string }).csrf;
  }
  send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return fetch(s.url + path, {
      method,
      redirect: "manual",
      headers: {
        cookie: this.cookie,
        origin: ORIGIN,
        "x-csrf-token": this.csrf,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
}

let directorLink = "";
let directorId = 0;
let codirectorLink = "";
const director = new Browser();
const codirector = new Browser();
let threadId = 0;

describe("security basics", () => {
  it("sends security headers and no-store on pages", async () => {
    const res = await fetch(s.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await res.text()).toContain('<meta name="referrer" content="same-origin">');
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("requires auth on every API route", async () => {
    for (const [method, path] of [
      ["GET", "/api/versions"],
      ["GET", "/api/threads"],
      ["GET", "/api/versions/1/pdf"],
      ["POST", "/api/threads"],
      ["GET", "/api/directors"],
      ["PUT", "/api/settings"],
    ] as const) {
      const res = await fetch(s.url + path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect((await fetch(s.url + "/v/1", { redirect: "manual" })).status).toBe(303);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await fetch(s.url + "/api/versions", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("serves pdf.js and static files", async () => {
    const res = await fetch(s.url + "/vendor/pdfjs/pdf.mjs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await fetch(s.url + "/vendor/pdfjs/pdf.worker.mjs")).status).toBe(200);
    expect((await fetch(s.url + "/static/viewer.js")).status).toBe(200);
    expect((await fetch(s.url + "/static/../package.json")).status).toBe(404);
    expect((await fetch(s.url + "/vendor/pdfjs/package.json")).status).toBe(404);
  });
});

describe("publishing", () => {
  it("rejects files that are not PDFs and invalid avance.json", async () => {
    let res = await owner("/api/versions", { method: "POST", body: publishForm(new TextEncoder().encode("hola"), sampleAvance()) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no es un PDF/);
    res = await owner("/api/versions", {
      method: "POST",
      body: publishForm(new TextEncoder().encode("%PDF-1.4\ngarbage"), sampleAvance()),
    });
    expect(res.status).toBe(400);
    res = await owner("/api/versions", { method: "POST", body: publishForm(sampleThesis(), { schema: 2 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/schema/);
  });

  it("rejects oversized uploads", async () => {
    const small = await startTestServer({ MAX_PDF_MB: "1" });
    try {
      const big = new Uint8Array(3 * 1024 * 1024);
      big.set(new TextEncoder().encode("%PDF-1.4"));
      const res = await fetch(small.url + "/api/versions", {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_TOKEN}` },
        body: publishForm(big, sampleAvance()),
      });
      expect(res.status).toBe(413);
    } finally {
      await small.stop();
    }
  });

  it("publishes version 1 and finds the chapters in the PDF", async () => {
    const res = await owner("/api/versions", { method: "POST", body: publishForm(sampleThesis(), sampleAvance(), "Primera versión") });
    expect(res.status).toBe(201);
    const { version } = (await res.json()) as { version: { number: number; page_count: number; chapters: { id: string; start_page: number }[] } };
    expect(version.number).toBe(1);
    expect(version.page_count).toBe(5);
    expect(version.chapters.map((c) => c.start_page)).toEqual([3, 4, 5]);
  });
});

describe("director links", () => {
  it("creates links (shown once) and stores only hashes", async () => {
    let res = await ownerJson("POST", "/api/directors", {
      name: "Dra. Ana Torres Ruiz",
      role: "Director",
      email: "director@example.test",
      notify_versions: true,
    });
    expect(res.status).toBe(201);
    const a = (await res.json()) as { link: string; director: { id: number } };
    directorLink = a.link;
    directorId = a.director.id;
    expect(directorLink).toMatch(/^https:\/\/revision\.example\.test\/acceso\/[A-Za-z0-9_-]{43}$/);
    res = await ownerJson("POST", "/api/directors", { name: "Dr. Luis Méndez Ortega", role: "Codirector" });
    codirectorLink = ((await res.json()) as { link: string }).link;

    const rows = await s.repo.db.query<{ token_hash: string }>("select token_hash from directors");
    const secret = directorLink.split("/").pop()!;
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== secret)).toBe(true);
    const list = await (await owner("/api/directors")).json();
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  it("a director link sets a session cookie and redirects to a clean URL", async () => {
    const res = await director.get(new URL(directorLink).pathname);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/__Host-rt_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly/);
    expect(set).not.toContain(directorLink.split("/").pop()!);
    const home = await director.get("/");
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/v/1");
    const page = await director.get("/v/1");
    expect(page.status).toBe(200);
    const htmlText = await page.text();
    expect(htmlText).toContain("Dra. Ana Torres Ruiz");
    expect(htmlText).toContain('<meta name="csrf-token"');
    await director.login();
    await codirector.get(new URL(codirectorLink).pathname);
    await codirector.login();
  });

  it("a link opened in a browser with someone else's session asks before switching", async () => {
    const b = new Browser();
    await b.get(new URL(codirectorLink).pathname);
    await b.login();
    const oldCookie = b.cookie;
    const secret = new URL(directorLink).pathname.split("/").pop()!;
    const page = await b.get(`/acceso/${secret}`);
    expect(page.status).toBe(200);
    expect(page.headers.getSetCookie()).toEqual([]);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const text = await page.text();
    expect(text).toContain("Entrar como Dra. Ana Torres Ruiz");
    expect(text).toContain("Dr. Luis Méndez Ortega");
    expect(((await (await b.get("/api/me")).json()) as { name: string }).name).toBe("Dr. Luis Méndez Ortega");
    const post = (csrf: string, extra: Record<string, string> = {}) =>
      fetch(s.url + "/acceso", {
        method: "POST",
        redirect: "manual",
        headers: { cookie: b.cookie, origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...extra },
        body: new URLSearchParams({ _csrf: csrf, secret }).toString(),
      });
    expect((await post("wrong")).status).toBe(403);
    expect((await post(b.csrf, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const ok = await post(b.csrf);
    expect(ok.status).toBe(303);
    b.cookie = ok.headers.getSetCookie()[0]!.split(";")[0]!;
    expect(((await (await b.get("/api/me")).json()) as { name: string }).name).toBe("Dra. Ana Torres Ruiz");
    expect((await fetch(s.url + "/api/me", { headers: { cookie: oldCookie } })).status).toBe(401);
    // Its own link again: no question, no new session.
    const again = await b.get(`/acceso/${secret}`);
    expect(again.status).toBe(303);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("an invalid link gives 404", async () => {
    const res = await fetch(s.url + "/acceso/" + "x".repeat(43), { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("malformed links give 404 (not 500) and the path never reaches the logs", async () => {
    for (const p of ["/acceso/%E0%A4%A", "/acceso/" + "a".repeat(42) + "%", "/acceso/abc%2Fdef", "/acceso/" + "b".repeat(44)]) {
      const res = await fetch(s.url + p, { redirect: "manual" });
      expect(res.status, p).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(s.logs.join("\n")).not.toContain("/acceso/");
    expect(s.logs.filter((l) => l.startsWith("error "))).toEqual([]);
  });

  it("directors cannot use owner endpoints", async () => {
    expect((await director.get("/api/directors")).status).toBe(403);
    expect((await director.send("POST", "/api/directors", { name: "x" })).status).toBe(403);
  });
});

describe("comments", () => {
  it("a director comments on selected text", async () => {
    const res = await director.send("POST", "/api/threads", {
      version: 1,
      page: 3,
      anchor: "text",
      quote: "sin una revisión formal suficiente",
      rects: [{ x: 0.12, y: 0.2, w: 0.4, h: 0.02 }],
      body: "**Sugerencia:** cite una fuente para esta afirmación. <script>alert(1)</script>",
    });
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as {
      thread: { id: number; chapter: { id: string }; comments: { body_html: string; author: { name: string } }[]; url: string };
    };
    threadId = thread.id;
    expect(thread.chapter.id).toBe("01-introduccion");
    expect(thread.comments[0]!.author.name).toBe("Dra. Ana Torres Ruiz");
    expect(thread.comments[0]!.body_html).toContain("<strong>Sugerencia:</strong>");
    expect(thread.comments[0]!.body_html).toContain("&lt;script&gt;");
    expect(thread.comments[0]!.body_html).not.toContain("<script>");
    expect(thread.url).toBe(`${ORIGIN}/v/1#hilo-${thread.id}`);
    await settle();
    expect(s.telegrams.at(-1)).toContain("Comentario nuevo de Dra. Ana Torres Ruiz");
    expect(s.telegrams.at(-1)).toContain(`${ORIGIN}/v/1#hilo-${thread.id}`);
    expect(s.mails.at(-1)!.to).toBe("autor@example.test");
    expect(s.mails.at(-1)!.text).not.toMatch(/acceso\//);
  });

  it("enforces CSRF on cookie-authenticated mutations", async () => {
    const body = { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" };
    expect((await director.send("POST", "/api/threads", body, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await director.send("POST", "/api/threads", body, { origin: "https://evil.example" })).status).toBe(403);
    const noOrigin = await fetch(s.url + "/api/threads", {
      method: "POST",
      headers: { cookie: director.cookie, "x-csrf-token": director.csrf, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(noOrigin.status).toBe(403);
  });

  it("validates comment input", async () => {
    const bad = [
      { version: 1, page: 99, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" },
      { version: 1, page: 1, anchor: "point", rects: [{ x: 2, y: 0.5, w: 0, h: 0 }], body: "x" },
      { version: 1, page: 1, anchor: "text", quote: "", rects: [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], body: "x" },
      { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "   " },
      { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x".repeat(10_001) },
    ];
    for (const b of bad) expect((await director.send("POST", "/api/threads", b)).status).toBe(400);
  });

  it("numeric fields and ids must be integers in range (400, no stack trace in the logs)", async () => {
    const base = { anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" };
    for (const b of [
      { ...base, version: 1.5, page: 1 },
      { ...base, version: 1e12, page: 1 },
      { ...base, version: "1", page: 1 },
      { ...base, version: 1, page: 1.5 },
      { ...base, version: 1, page: 1e12 },
    ]) {
      expect((await director.send("POST", "/api/threads", b)).status, JSON.stringify(b)).toBe(400);
    }
    for (const p of ["/api/threads/abc", "/api/threads/99999999999", "/api/threads?version=abc", "/api/versions/0", "/api/versions/1e3/pdf"]) {
      expect((await director.get(p)).status, p).toBe(400);
    }
    expect((await director.send("POST", "/api/threads/1.5/comments", { body: "x" })).status).toBe(400);
    expect(s.logs.filter((l) => l.startsWith("error "))).toEqual([]);
  });

  it("threads: replies from owner and codirector, edit and soft delete of own comments only", async () => {
    let res = await ownerJson("POST", `/api/threads/${threadId}/comments`, { body: "Gracias, agrego la cita." });
    expect(res.status).toBe(201);
    res = await codirector.send("POST", `/api/threads/${threadId}/comments`, { body: "De acuerdo con el director." });
    expect(res.status).toBe(201);
    const { thread, comment_id } = (await res.json()) as { thread: { comments: { id: number; mine: boolean }[] }; comment_id: number };
    expect(thread.comments).toHaveLength(3);
    await settle();
    expect(s.telegrams.at(-1)).toContain("Respuesta de Dr. Luis Méndez Ortega");
    const before = s.telegrams.length;

    // The director can't edit the codirector's comment.
    expect((await director.send("PATCH", `/api/comments/${comment_id}`, { body: "hack" })).status).toBe(403);
    res = await codirector.send("PATCH", `/api/comments/${comment_id}`, { body: "Totalmente de acuerdo." });
    expect(res.status).toBe(200);
    res = await codirector.send("DELETE", `/api/comments/${comment_id}`);
    const after = (await res.json()) as { thread: { comments: { id: number; deleted: boolean; body: string | null }[] } };
    const deleted = after.thread.comments.find((c) => c.id === comment_id)!;
    expect(deleted.deleted).toBe(true);
    expect(deleted.body).toBeNull();
    // The row is still there (soft delete).
    const rows = await s.repo.db.query("select deleted_at from comments where id = $1", [comment_id]);
    expect(rows).toHaveLength(1);
    await settle();
    expect(s.telegrams.length).toBe(before); // owner replies/edits/deletes don't notify
  });

  it("only the opener or the owner can resolve; anyone who sees the thread can reopen", async () => {
    // threadId was opened by the director.
    let res = await codirector.send("POST", `/api/threads/${threadId}/resolve`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/Solo quien abrió el hilo/);
    const asCodir = (await (await codirector.get(`/api/threads/${threadId}`)).json()) as { thread: { can_resolve: boolean } };
    expect(asCodir.thread.can_resolve).toBe(false);
    res = await director.send("POST", `/api/threads/${threadId}/resolve`);
    expect(((await res.json()) as { thread: { status: string; resolved_by: string; can_resolve: boolean } }).thread).toMatchObject({
      status: "resolved",
      resolved_by: "Dra. Ana Torres Ruiz",
      can_resolve: true,
    });
    res = await owner(`/api/threads?status=open`);
    expect(((await res.json()) as { threads: unknown[] }).threads).toHaveLength(0);
    // The codirector can't resolve it, but can reopen it.
    res = await codirector.send("POST", `/api/threads/${threadId}/reopen`);
    expect(((await res.json()) as { thread: { status: string; resolved_by: string | null } }).thread).toMatchObject({ status: "open", resolved_by: null });
    // The owner can always resolve.
    res = await owner(`/api/threads/${threadId}/resolve`, { method: "POST" });
    expect(((await res.json()) as { thread: { status: string } }).thread.status).toBe("resolved");
    res = await owner(`/api/threads/${threadId}/reopen`, { method: "POST" });
    expect(((await res.json()) as { thread: { status: string } }).thread.status).toBe("open");
  });

  it("visibility setting: 'own' hides other directors' threads and comments", async () => {
    let res = await codirector.send("POST", "/api/threads", {
      version: 1,
      page: 4,
      anchor: "point",
      rects: [{ x: 0.3, y: 0.4, w: 0, h: 0 }],
      body: "Falta una figura aquí.",
    });
    const codirThread = ((await res.json()) as { thread: { id: number } }).thread.id;
    // An owner thread where both directors reply.
    res = await ownerJson("POST", "/api/threads", { version: 1, page: 5, anchor: "point", rects: [{ x: 0.2, y: 0.2, w: 0, h: 0 }], body: "¿Les parece bien esta conclusión?" });
    const ownerThread = ((await res.json()) as { thread: { id: number } }).thread.id;
    await codirector.send("POST", `/api/threads/${ownerThread}/comments`, { body: "Opinión del codirector" });
    await director.send("POST", `/api/threads/${ownerThread}/comments`, { body: "Opinión del director" });
    // Legacy row (resolved before resolved_by_kind existed) by the codirector.
    await s.repo.db.query("update threads set status = 'resolved', resolved_by = $2, resolved_at = now() where id = $1", [ownerThread, "Dr. Luis Méndez Ortega"]);

    const list = async (b: Browser) =>
      ((await (await b.get("/api/threads?status=all")).json()) as {
        threads: { id: number; resolved_by: string | null; comments: { author: { name: string }; body: string | null }[] }[];
      }).threads;
    expect((await list(director)).length).toBe(3);
    expect((await ownerJson("PUT", "/api/settings", { comments_visibility: "own" })).status).toBe(200);
    const mine = await list(director);
    expect(mine.map((t) => t.id).sort()).toEqual([threadId, ownerThread].sort());
    const ot = mine.find((t) => t.id === ownerThread)!;
    expect(ot.comments.map((c) => c.author.name)).toEqual(["Eduardo Ejemplo", "Dra. Ana Torres Ruiz"]);
    expect(JSON.stringify(mine)).not.toContain("Opinión del codirector");
    expect(JSON.stringify(mine)).not.toContain("Méndez");
    expect(ot.resolved_by).toBeNull();
    const single = (await (await director.get(`/api/threads/${ownerThread}`)).json()) as { thread: { comments: unknown[] } };
    expect(single.thread.comments).toHaveLength(2);
    expect((await list(codirector)).map((t) => t.id).sort()).toEqual([codirThread, ownerThread].sort());
    expect((await director.send("POST", `/api/threads/${codirThread}/comments`, { body: "x" })).status).toBe(404);
    // The owner still sees everything.
    const all = (await (await owner(`/api/threads/${ownerThread}`)).json()) as { thread: { comments: unknown[]; resolved_by: string } };
    expect(all.thread.comments).toHaveLength(3);
    expect(all.thread.resolved_by).toBe("Dr. Luis Méndez Ortega");
    await ownerJson("PUT", "/api/settings", { comments_visibility: "all" });
    expect((await list(director)).length).toBe(3);
    await owner(`/api/threads/${ownerThread}/reopen`, { method: "POST" });
  });

  it("serves the PDF only with a session", async () => {
    const res = await director.get("/api/versions/1/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("versions and changes", () => {
  it("publishing v2 emails opted-in directors without their link, and computes the diff", async () => {
    const mailsBefore = s.mails.length;
    const res = await owner("/api/versions", { method: "POST", body: publishForm(sampleThesis(true), sampleAvance(true), "Atendí los comentarios del capítulo 1") });
    expect(res.status).toBe(201);
    await settle();
    const newMails = s.mails.slice(mailsBefore);
    expect(newMails.map((m) => m.to)).toEqual(["director@example.test"]);
    expect(newMails[0]!.subject).toContain("v2");
    expect(newMails[0]!.text).not.toContain("/acceso/");
    expect(newMails[0]!.text).toContain("Atendí los comentarios");

    const diff = (await (await director.get("/api/versions/2/diff")).json()) as {
      diff: { previous: number; mode: string; chapters: { id: string; words_delta: number; added: number; hunks: { op: string; text: string }[][] }[] };
    };
    expect(diff.diff.previous).toBe(1);
    expect(diff.diff.mode).toBe("chapters");
    const intro = diff.diff.chapters.find((c) => c.id === "01-introduccion")!;
    expect(intro.words_delta).toBe(350);
    expect(intro.added).toBeGreaterThan(0);
    expect(intro.hunks.flat().some((o) => o.op === "add" && o.text.includes("anonimizar los datos de viajes"))).toBe(true);
    const marco = diff.diff.chapters.find((c) => c.id === "02-marco-teorico")!;
    expect(marco.hunks).toEqual([]);

    const page = await director.get("/v/2/cambios");
    const text = await page.text();
    expect(text).toContain("Avance por capítulo");
    expect(text).toContain("+350");
  });

  it("comments stay with the version they were made on", async () => {
    const v1 = (await (await owner("/api/threads?version=1&status=all")).json()) as { threads: unknown[] };
    const v2 = (await (await owner("/api/threads?version=latest&status=all")).json()) as { threads: unknown[] };
    expect(v1.threads.length).toBe(3);
    expect(v2.threads.length).toBe(0);
  });
});

describe("owner web login", () => {
  it("logs in with the token once and gets a session; wrong token is rejected", async () => {
    const b = new Browser();
    const form = await fetch(s.url + "/entrar");
    const pre = form.headers.getSetCookie()[0]!.split(";")[0]!;
    const preValue = pre.split("=")[1]!;
    const post = (token: string, origin = ORIGIN) =>
      fetch(s.url + "/entrar", {
        method: "POST",
        redirect: "manual",
        headers: { cookie: pre, origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: preValue, token }).toString(),
      });
    expect((await post("wrong")).status).toBe(401);
    expect((await post(OWNER_TOKEN, "https://evil.example")).status).toBe(403);
    const ok = await post(OWNER_TOKEN);
    expect(ok.status).toBe(303);
    b.cookie = ok.headers.getSetCookie().find((c) => c.startsWith("__Host-rt_session="))!.split(";")[0]!;
    const dash = await b.get("/");
    const text = await dash.text();
    expect(text).toContain("Tu tesis");
    expect(text).toContain("Dr. Luis Méndez Ortega");
    expect(s.logs.join("\n")).not.toContain(OWNER_TOKEN);
  });

  it("rate-limits the login endpoint", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await fetch(s.url + "/entrar", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "token=x" })).status;
    }
    expect(last).toBe(429);
  });
});

describe("revocation and rotation", () => {
  it("revoking a director ends their session; rotating gives a new link and kills the old one", async () => {
    let res = await ownerJson("POST", `/api/directors/${directorId}/revoke`, {});
    expect(res.status).toBe(200);
    expect((await director.get("/api/me")).status).toBe(401);
    expect((await fetch(s.url + new URL(directorLink).pathname, { redirect: "manual" })).status).toBe(404);

    res = await ownerJson("POST", `/api/directors/${directorId}/rotate`, { send_link: true });
    const r = (await res.json()) as { link: string; email: { sent: boolean } };
    expect(r.link).not.toBe(directorLink);
    expect(r.email.sent).toBe(true);
    expect(s.mails.at(-1)!.to).toBe("director@example.test");
    expect(s.mails.at(-1)!.text).toContain(r.link);
    const b = new Browser();
    expect((await b.get(new URL(r.link).pathname)).status).toBe(303);
    await b.login();
    expect(b.csrf).toHaveLength(43);
    expect(s.logs.join("\n")).not.toContain(r.link.split("/").pop()!);
  });
});

describe("HTML form posts that carry Origin: null", () => {
  it("accept Origin: null only with Sec-Fetch-Site: same-origin", async () => {
    // A fresh server: the login limiter of the shared one is exhausted by now.
    const fresh = await startTestServer();
    try {
      const f = await fetch(fresh.url + "/entrar");
      const pre = f.headers.getSetCookie()[0]!.split(";")[0]!;
      const post = (site: string) =>
        fetch(fresh.url + "/entrar", {
          method: "POST",
          redirect: "manual",
          headers: { cookie: pre, origin: "null", "sec-fetch-site": site, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ _csrf: pre.split("=")[1]!, token: OWNER_TOKEN }).toString(),
        });
      expect((await post("cross-site")).status).toBe(403);
      expect((await post("same-origin")).status).toBe(303);
    } finally {
      await fresh.stop();
    }
  });
});

describe("daily digest and the owner client", () => {
  it("sends the digest once per local day, after DIGEST_HOUR", async () => {
    const { runDigest } = await import("../src/server/main.js");
    const { loadConfig } = await import("../src/config.js");
    const { Notifier } = await import("../src/notify/notify.js");
    const sent: string[] = [];
    const notifier = new Notifier({
      publicUrl: ORIGIN,
      thesisTitle: async () => "T",
      telegram: { send: async (t) => void sent.push(t) },
      mailer: null,
      ownerEmail: "",
      instant: false,
      log: () => undefined,
    });
    const config = loadConfig({ DIGEST_HOUR: "8", TZ: "America/Mexico_City" });
    const now = new Date(); // comments in this test file were written moments ago
    const local = (h: number) => {
      // A time today (Mexico City) at hour h; the test only needs "before"/"after".
      const d = new Date(now);
      d.setUTCHours(h + 6, 30, 0, 0);
      return d;
    };
    expect(await runDigest(config, s.repo, notifier, local(7))).toBe(false); // before 8:00
    const at9 = local(9);
    await s.repo.db.query("delete from digest_runs");
    // Pretend the comments were written in the 24 h before 9:00.
    await s.repo.db.query("update comments set created_at = $1", [new Date(at9.getTime() - 3600_000)]);
    expect(await runDigest(config, s.repo, notifier, at9)).toBe(true);
    expect(sent[0]).toMatch(/Resumen diario: \d+ comentario/);
    expect(await runDigest(config, s.repo, notifier, new Date(at9.getTime() + 3600_000))).toBe(false); // same day
  });

  it("the CLI client publishes and lists with the owner token", async () => {
    const { Client } = await import("../src/client.js");
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(s.dir, "t.pdf"), sampleThesis(true));
    await writeFile(join(s.dir, "a.json"), JSON.stringify(sampleAvance(true)));
    const client = new Client({ url: s.url, token: OWNER_TOKEN });
    const r = await client.publish(join(s.dir, "t.pdf"), join(s.dir, "a.json"), "desde el cliente");
    expect(r.version.number).toBe(3);
    const { threads } = await client.threads({ status: "all" });
    expect(threads.length).toBeGreaterThan(0);
    await expect(new Client({ url: s.url, token: "nope" }).threads({})).rejects.toThrow(/Token no válido/);
  });
});

describe("untrusted text", () => {
  it("stores comments without control or bidi characters", async () => {
    const res = await codirector.send("POST", "/api/threads", {
      version: 1,
      page: 2,
      anchor: "point",
      rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }],
      body: "ok \u001b[2J\u001b]0;x\u0007 \u202efin\u0000\r\nlínea 2",
    });
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as { thread: { comments: { body: string }[] } };
    expect(thread.comments[0]!.body).toBe("ok [2J]0;x fin\nlínea 2");
  });
});

describe("owner sessions", () => {
  it("stop working when the owner token changes", async () => {
    const { Repo, ownerSessionFingerprint } = await import("../src/repo.js");
    const { sha256Hex } = await import("../src/server/crypto.js");
    const before = new Repo(s.repo.db, "x", ownerSessionFingerprint(sha256Hex(OWNER_TOKEN)));
    const after = new Repo(s.repo.db, "x", ownerSessionFingerprint(sha256Hex("rt_owner_rotated")));
    const sess = await before.createSession("owner", null, 3600_000);
    expect(await before.getSession(sess.id, () => 3600_000)).not.toBeNull();
    expect(await after.getSession(sess.id, () => 3600_000)).toBeNull();
    // ...and the row is gone, even for the old token.
    expect(await before.getSession(sess.id, () => 3600_000)).toBeNull();
    const other = await before.createSession("owner", null, 3600_000);
    expect(await after.purgeStaleOwnerSessions()).toBeGreaterThanOrEqual(1);
    expect(await before.getSession(other.id, () => 3600_000)).toBeNull();
  });

  it("«Cerrar todas las sesiones» closes the owner's web sessions and, if asked, the directors'", async () => {
    const fresh = await startTestServer();
    try {
      const login = async () => {
        const f = await fetch(fresh.url + "/entrar");
        const pre = f.headers.getSetCookie()[0]!.split(";")[0]!;
        const ok = await fetch(fresh.url + "/entrar", {
          method: "POST",
          redirect: "manual",
          headers: { cookie: pre, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ _csrf: pre.split("=")[1]!, token: OWNER_TOKEN }).toString(),
        });
        return ok.headers.getSetCookie().find((c) => c.startsWith("__Host-rt_session="))!.split(";")[0]!;
      };
      const bearer = { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" };
      const d = (await (await fetch(fresh.url + "/api/directors", { method: "POST", headers: bearer, body: JSON.stringify({ name: "Dr. X" }) })).json()) as { link: string };
      const dCookie = (await fetch(fresh.url + new URL(d.link).pathname, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
      const me = (cookie: string) => fetch(fresh.url + "/api/me", { headers: { cookie } }).then((r) => r.status);
      const web1 = await login();
      const web2 = await login();
      let r = await fetch(fresh.url + "/api/sessions/close-all", { method: "POST", headers: bearer, body: JSON.stringify({}) });
      expect(((await r.json()) as { closed: unknown }).closed).toEqual({ owner: 2, directors: 0 });
      expect([await me(web1), await me(web2), await me(dCookie)]).toEqual([401, 401, 200]);
      // From the browser (cookie + CSRF), directors too; the response clears the cookie.
      const web3 = await login();
      const csrf = ((await (await fetch(fresh.url + "/api/me", { headers: { cookie: web3 } })).json()) as { csrf: string }).csrf;
      r = await fetch(fresh.url + "/api/sessions/close-all", {
        method: "POST",
        headers: { cookie: web3, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ directors: true }),
      });
      expect(((await r.json()) as { closed: unknown }).closed).toEqual({ owner: 1, directors: 1 });
      expect(r.headers.getSetCookie()[0]).toMatch(/^__Host-rt_session=; .*Max-Age=0/);
      expect([await me(web3), await me(dCookie)]).toEqual([401, 401]);
      // Directors can't do it.
      const d2 = (await (await fetch(fresh.url + `/api/directors/1/rotate`, { method: "POST", headers: bearer, body: "{}" })).json()) as { link: string };
      const d2Cookie = (await fetch(fresh.url + new URL(d2.link).pathname, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
      const dcsrf = ((await (await fetch(fresh.url + "/api/me", { headers: { cookie: d2Cookie } })).json()) as { csrf: string }).csrf;
      r = await fetch(fresh.url + "/api/sessions/close-all", {
        method: "POST",
        headers: { cookie: d2Cookie, origin: ORIGIN, "x-csrf-token": dcsrf, "content-type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(403);
    } finally {
      await fresh.stop();
    }
  });
});
