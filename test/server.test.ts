import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleAvance, sampleProgress, sampleThesis } from "./fixtures/make-pdf.mjs";
import { Browser, ORIGIN, OWNER_TOKEN, publishForm, settle, startTestServer, type TestServer } from "./helpers.js";

let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s.stop();
});

const ANA = "Dra. Ana Torres Ruiz";
const LUIS = "Dr. Luis Méndez Ortega";

let anaThesisLink = "";
let anaReportLink = "";
let anaThesisInv = 0;
let anaReportInv = 0;
let anaPerson = 0;
let luisLink = "";
let luisInv = 0;
let ana: Browser; // opened the thesis link only
let luis: Browser;
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
      ["GET", "/api/documents"],
      ["POST", "/api/documents"],
      ["GET", "/api/documents/x/versions"],
      ["GET", "/api/documents/x/threads"],
      ["GET", "/api/documents/x/versions/1/pdf"],
      ["POST", "/api/documents/x/threads"],
      ["GET", "/api/people"],
      ["GET", "/api/threads/1"],
      ["POST", "/api/invitations/1/rotate"],
      ["GET", "/api/settings"],
    ] as const) {
      const res = await fetch(s.url + path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect((await fetch(s.url + "/d/x/v/1", { redirect: "manual" })).status).toBe(303);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await fetch(s.url + "/api/documents", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("serves pdf.js and static files, nothing else", async () => {
    const res = await fetch(s.url + "/vendor/pdfjs/pdf.mjs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await fetch(s.url + "/vendor/pdfjs/pdf.worker.mjs")).status).toBe(200);
    expect((await fetch(s.url + "/static/viewer.js")).status).toBe(200);
    expect((await fetch(s.url + "/static/i18n-format.js")).status).toBe(200);
    expect((await fetch(s.url + "/static/../package.json")).status).toBe(404);
    expect((await fetch(s.url + "/vendor/pdfjs/package.json")).status).toBe(404);
  });

  it("pages outside a document follow Accept-Language", async () => {
    const en = await (await fetch(s.url + "/", { headers: { "accept-language": "en-US,en;q=0.9" } })).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("Owner sign-in");
    const es = await (await fetch(s.url + "/", { headers: { "accept-language": "es-MX,es;q=0.9,en;q=0.5" } })).text();
    expect(es).toContain('<html lang="es">');
    expect(es).toContain("Acceso del autor");
    expect(await (await fetch(s.url + "/", { headers: { "accept-language": "fr" } })).text()).toContain('<html lang="en">');
  });
});

describe("documents", () => {
  it("are created by the owner with a valid, unique slug", async () => {
    expect((await s.ownerJson("POST", "/api/documents", { slug: "thesis", title: "Método computacional", language: "es", default_role: "Director(a)" })).status).toBe(201);
    expect((await s.ownerJson("POST", "/api/documents", { slug: "report", title: "Q3 report for ACME", language: "en" })).status).toBe(201);
    for (const slug of ["Thesis", "-x", "x-", "a/b", "", "a".repeat(64), "ñ"]) {
      expect((await s.ownerJson("POST", "/api/documents", { slug, title: "x" })).status, slug).toBe(400);
    }
    const dup = await s.ownerJson("POST", "/api/documents", { slug: "thesis", title: "again" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already has that short name/);
    expect((await s.ownerJson("POST", "/api/documents", { slug: "x1", title: "x", language: "fr" })).status).toBe(400);
    expect((await s.ownerJson("POST", "/api/documents", { slug: "x1", title: "x", visibility: "some" })).status).toBe(400);
    const { documents } = (await (await s.owner("/api/documents")).json()) as { documents: { slug: string; language: string; default_role: string }[] };
    expect(documents.map((d) => d.slug)).toEqual(["thesis", "report"]);
    expect(documents[0]).toMatchObject({ language: "es", default_role: "Director(a)" });
  });

  it("can be renamed (title and slug); a taken slug is refused", async () => {
    await s.createDoc("tmp-doc");
    let res = await s.ownerJson("PATCH", "/api/documents/tmp-doc", { title: "Paper draft", slug: "paper" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { document: { slug: string; title: string } }).document).toMatchObject({ slug: "paper", title: "Paper draft" });
    expect((await s.owner("/api/documents/tmp-doc")).status).toBe(404);
    res = await s.ownerJson("PATCH", "/api/documents/paper", { slug: "thesis" });
    expect(res.status).toBe(409);
  });
});

describe("publishing", () => {
  it("rejects files that are not PDFs and invalid progress.json", async () => {
    let res = await s.owner("/api/documents/thesis/versions", { method: "POST", body: publishForm(new TextEncoder().encode("hola"), sampleProgress()) });
    expect(res.status).toBe(400);
    // The thesis is in Spanish, but API messages follow Accept-Language.
    expect(((await res.json()) as { error: string }).error).toMatch(/not a PDF/);
    res = await s.owner("/api/documents/thesis/versions", { method: "POST", headers: { "accept-language": "es" }, body: publishForm(new TextEncoder().encode("hola"), sampleProgress()) });
    expect(((await res.json()) as { error: string }).error).toMatch(/no es un PDF/);
    res = await s.owner("/api/documents/thesis/versions", { method: "POST", body: publishForm(new TextEncoder().encode("%PDF-1.4\ngarbage"), sampleProgress()) });
    expect(res.status).toBe(400);
    res = await s.owner("/api/documents/thesis/versions", { method: "POST", body: publishForm(sampleThesis(), { schema: 2 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/schema/);
    expect((await s.publish("nope")).status).toBe(404);
  });

  it("rejects oversized uploads", async () => {
    const small = await startTestServer({ MAX_PDF_MB: "1" });
    try {
      await small.createDoc("d");
      const big = new Uint8Array(3 * 1024 * 1024);
      big.set(new TextEncoder().encode("%PDF-1.4"));
      expect((await small.publish("d", big)).status).toBe(413);
    } finally {
      await small.stop();
    }
  });

  it("publishes version 1 and finds the sections in the PDF", async () => {
    const res = await s.publish("thesis", sampleThesis(), sampleProgress(), "Primera versión");
    expect(res.status).toBe(201);
    const { version, url } = (await res.json()) as { version: { number: number; page_count: number; sections: { id: string; start_page: number }[] }; url: string };
    expect(version.number).toBe(1);
    expect(version.page_count).toBe(5);
    expect(version.sections.map((c) => c.start_page)).toEqual([3, 4, 5]);
    expect(url).toBe(`${ORIGIN}/d/thesis/v/1`);
  });

  it("numbers versions per document; progress.json is optional and avance.json is accepted", async () => {
    let res = await s.owner("/api/documents/report/versions", { method: "POST", body: publishForm(sampleThesis(), null, "No progress") });
    expect(res.status).toBe(201);
    const v1 = ((await res.json()) as { version: { number: number; progress: unknown; sections: unknown[] } }).version;
    expect(v1).toMatchObject({ number: 1, progress: null, sections: [] });
    // The thesis template's file and field name.
    res = await s.owner("/api/documents/report/versions", { method: "POST", body: publishForm(sampleThesis(true), sampleAvance(true), "", "avance") });
    expect(res.status).toBe(201);
    const v2 = ((await res.json()) as { version: { number: number; progress: { sections: { status: string }[] } } }).version;
    expect(v2.number).toBe(2);
    expect(v2.progress.sections[0]!.status).toBe("review");
    // Without progress on one side, the diff covers the whole document.
    await settle();
    const diff = ((await (await s.owner("/api/documents/report/versions/2/diff")).json()) as { diff: { mode: string; sections: { id: string | null }[] } }).diff;
    expect(diff.mode).toBe("document");
  });
});

describe("invitations and links", () => {
  it("create links (shown once) and store only hashes; the role defaults to the document's", async () => {
    let r = await s.invite("thesis", { name: ANA, email: "director@example.test" });
    anaThesisLink = r.link;
    anaThesisInv = r.invitationId;
    anaPerson = r.personId;
    expect(anaThesisLink).toMatch(/^https:\/\/review\.example\.test\/a\/[A-Za-z0-9_-]{43}$/);
    await s.ownerJson("PATCH", `/api/people/${anaPerson}`, { notify_versions: true });
    // The same person, invited to a second document with another role.
    r = await s.invite("report", { person_id: anaPerson, role: "Reviewer" });
    anaReportLink = r.link;
    anaReportInv = r.invitationId;
    expect(r.personId).toBe(anaPerson);
    expect(anaReportLink).not.toBe(anaThesisLink);
    r = await s.invite("thesis", { name: LUIS, role: "Codirector(a)" });
    luisLink = r.link;
    luisInv = r.invitationId;
    expect((await s.ownerJson("POST", "/api/documents/thesis/invitations", { person_id: anaPerson })).status).toBe(409);
    expect((await s.ownerJson("POST", "/api/documents/thesis/invitations", { person_id: 1.5 })).status).toBe(400);
    expect((await s.ownerJson("POST", "/api/documents/thesis/invitations", { person_id: 999 })).status).toBe(404);

    const rows = await s.repo.db.query<{ token_hash: string }>("select token_hash from invitations");
    const secret = anaThesisLink.split("/").pop()!;
    expect(rows.every((x) => /^[0-9a-f]{64}$/.test(x.token_hash) && x.token_hash !== secret)).toBe(true);
    for (const path of ["/api/people", "/api/documents/thesis/invitations"]) {
      const text = await (await s.owner(path)).text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain("token_hash");
    }
    const list = (await (await s.owner("/api/documents/thesis/invitations")).json()) as { invitations: { role: string; person: { name: string } }[] };
    expect(list.invitations.map((i) => [i.person.name, i.role])).toEqual([
      [LUIS, "Codirector(a)"],
      [ANA, "Director(a)"],
    ]);
  });

  it("a link sets a session cookie and redirects to the document, without the secret", async () => {
    ana = await s.browser();
    const res = await ana.get(new URL(anaThesisLink).pathname);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/d/thesis");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/__Host-dr_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; Secure; SameSite=Lax; HttpOnly/);
    expect(set).not.toContain(anaThesisLink.split("/").pop()!);
    await ana.login();
    const doc = await ana.get("/d/thesis");
    expect(doc.status).toBe(303);
    expect(doc.headers.get("location")).toBe("/d/thesis/v/1");
    const page = await ana.get("/d/thesis/v/1");
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain(ANA);
    expect(text).toContain('<meta name="csrf-token"');
    // The thesis is in Spanish: its pages too, and the script's messages.
    expect(text).toContain('<html lang="es">');
    expect(text).toContain("Comentar un punto");
    expect(text).toContain('"js.reply":"Responder"');
    luis = await s.browser(luisLink);
  });

  it("one session holds all of a person's documents: the list, both documents, a role per document", async () => {
    // Opened with the thesis link only, and still sees the report (the same person).
    const home = await ana.get("/", { "accept-language": "en" });
    expect(home.status).toBe(200);
    const text = await home.text();
    expect(text).toContain("Q3 report for ACME");
    expect(text).toContain("Método computacional");
    expect(text).toContain("Reviewer");
    const { documents } = await ana.json<{ documents: { slug: string; role: string }[] }>("/api/documents");
    expect(documents.map((d) => [d.slug, d.role])).toEqual([
      ["thesis", "Director(a)"],
      ["report", "Reviewer"],
    ]);
    expect((await ana.get("/d/report/v/1")).status).toBe(200);
    expect(await (await ana.get("/d/report/v/1")).text()).toContain('<html lang="en">');
    // Opening the other link in the same browser adds it to the session (no question).
    const again = await ana.get(new URL(anaReportLink).pathname);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/d/report");
    expect(again.headers.getSetCookie()).toEqual([]);
    // A reviewer with one document goes straight to it.
    const h = await luis.get("/");
    expect(h.status).toBe(303);
    expect(h.headers.get("location")).toBe("/d/thesis");
  });

  it("a reviewer can't see documents they aren't invited to (404, pages and API)", async () => {
    for (const p of ["/d/report", "/d/report/v/1", "/d/report/v/1/changes", "/api/documents/report", "/api/documents/report/threads", "/api/documents/report/versions/1/pdf", "/api/documents/paper/versions"]) {
      expect((await luis.get(p)).status, p).toBe(404);
    }
    const { documents } = await luis.json<{ documents: { slug: string }[] }>("/api/documents");
    expect(documents.map((d) => d.slug)).toEqual(["thesis"]);
    expect((await luis.send("POST", "/api/documents/report/threads", { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" })).status).toBe(404);
    expect((await luis.get("/d/thesis/manage")).status).toBe(403);
  });

  it("a link opened in a browser with someone else's session asks before switching", async () => {
    const b = await s.browser(luisLink);
    const oldCookie = b.cookie;
    const secret = new URL(anaThesisLink).pathname.split("/").pop()!;
    const page = await b.get(`/a/${secret}`);
    expect(page.status).toBe(200);
    expect(page.headers.getSetCookie()).toEqual([]);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const text = await page.text();
    expect(text).toContain(`Entrar como ${ANA}`);
    expect(text).toContain(LUIS);
    expect((await b.json<{ name: string }>("/api/me")).name).toBe(LUIS);
    const post = (csrf: string, extra: Record<string, string> = {}) =>
      fetch(s.url + "/a", {
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
    expect((await b.json<{ name: string }>("/api/me")).name).toBe(ANA);
    expect((await fetch(s.url + "/api/me", { headers: { cookie: oldCookie } })).status).toBe(401);
  });

  it("an invalid link gives 404", async () => {
    const res = await fetch(s.url + "/a/" + "x".repeat(43), { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("malformed links give 404 (not 500) and the path never reaches the logs", async () => {
    for (const p of ["/a/%E0%A4%A", "/a/" + "a".repeat(42) + "%", "/a/abc%2Fdef", "/a/" + "b".repeat(44)]) {
      const res = await fetch(s.url + p, { redirect: "manual" });
      expect(res.status, p).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(s.logs.join("\n")).not.toContain("/a/");
    expect(s.logs.filter((l) => l.startsWith("error "))).toEqual([]);
  });

  it("reviewers cannot use owner endpoints", async () => {
    expect((await ana.get("/api/people")).status).toBe(403);
    expect((await ana.send("POST", "/api/people", { name: "x" })).status).toBe(403);
    expect((await ana.send("POST", "/api/documents", { slug: "mine", title: "x" })).status).toBe(403);
    expect((await ana.send("POST", `/api/invitations/${luisInv}/revoke`, {})).status).toBe(403);
    expect((await ana.get("/api/documents/thesis/invitations")).status).toBe(403);
  });
});

describe("comments", () => {
  it("a reviewer comments on selected text", async () => {
    const res = await ana.send("POST", "/api/documents/thesis/threads", {
      version: 1,
      page: 3,
      anchor: "text",
      quote: "sin una revisión formal suficiente",
      rects: [{ x: 0.12, y: 0.2, w: 0.4, h: 0.02 }],
      body: "**Sugerencia:** cite una fuente para esta afirmación. <script>alert(1)</script>",
    });
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as {
      thread: { id: number; section: { id: string }; comments: { body_html: string; author: { name: string; role: string } }[]; url: string };
    };
    threadId = thread.id;
    expect(thread.section.id).toBe("01-introduccion");
    expect(thread.comments[0]!.author).toMatchObject({ name: ANA, role: "Director(a)" });
    expect(thread.comments[0]!.body_html).toContain("<strong>Sugerencia:</strong>");
    expect(thread.comments[0]!.body_html).toContain("&lt;script&gt;");
    expect(thread.comments[0]!.body_html).not.toContain("<script>");
    expect(thread.url).toBe(`${ORIGIN}/d/thesis/v/1#thread-${thread.id}`);
    await settle();
    // The owner's notification is in the document's language.
    expect(s.telegrams.at(-1)).toContain(`Comentario nuevo de ${ANA} (Director(a))`);
    expect(s.telegrams.at(-1)).toContain(`${ORIGIN}/d/thesis/v/1#thread-${thread.id}`);
    expect(s.mails.at(-1)!.to).toBe("owner@example.test");
    expect(s.mails.at(-1)!.text).not.toMatch(/\/a\//);
  });

  it("enforces CSRF on cookie-authenticated mutations", async () => {
    const body = { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" };
    expect((await ana.send("POST", "/api/documents/thesis/threads", body, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await ana.send("POST", "/api/documents/thesis/threads", body, { origin: "https://evil.example" })).status).toBe(403);
    const noOrigin = await fetch(s.url + "/api/documents/thesis/threads", {
      method: "POST",
      headers: { cookie: ana.cookie, "x-csrf-token": ana.csrf, "content-type": "application/json" },
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
    for (const b of bad) expect((await ana.send("POST", "/api/documents/thesis/threads", b)).status).toBe(400);
    expect((await ana.send("POST", "/api/documents/thesis/threads", { ...bad[0], page: 1, version: 7 })).status).toBe(404);
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
      expect((await ana.send("POST", "/api/documents/thesis/threads", b)).status, JSON.stringify(b)).toBe(400);
    }
    for (const p of ["/api/threads/abc", "/api/threads/99999999999", "/api/documents/thesis/threads?version=abc", "/api/documents/thesis/versions/0", "/api/documents/thesis/versions/1e3/pdf"]) {
      expect((await ana.get(p)).status, p).toBe(400);
    }
    expect((await ana.send("POST", "/api/threads/1.5/comments", { body: "x" })).status).toBe(400);
    expect(s.logs.filter((l) => l.startsWith("error "))).toEqual([]);
  });

  it("threads: replies from the owner and a co-director, edit and soft delete of one's own comments only", async () => {
    let res = await s.ownerJson("POST", `/api/threads/${threadId}/comments`, { body: "Gracias, agrego la cita." });
    expect(res.status).toBe(201);
    res = await luis.send("POST", `/api/threads/${threadId}/comments`, { body: "De acuerdo con el director." });
    expect(res.status).toBe(201);
    const { thread, comment_id } = (await res.json()) as { thread: { comments: { id: number; mine: boolean }[] }; comment_id: number };
    expect(thread.comments).toHaveLength(3);
    expect(thread.comments.map((c) => c.mine)).toEqual([false, false, true]);
    await settle();
    expect(s.telegrams.at(-1)).toContain(`Respuesta de ${LUIS}`);
    const before = s.telegrams.length;

    expect((await ana.send("PATCH", `/api/comments/${comment_id}`, { body: "hack" })).status).toBe(403);
    res = await luis.send("PATCH", `/api/comments/${comment_id}`, { body: "Totalmente de acuerdo." });
    expect(res.status).toBe(200);
    res = await luis.send("DELETE", `/api/comments/${comment_id}`);
    const after = (await res.json()) as { thread: { comments: { id: number; deleted: boolean; body: string | null }[] } };
    const deleted = after.thread.comments.find((c) => c.id === comment_id)!;
    expect(deleted.deleted).toBe(true);
    expect(deleted.body).toBeNull();
    expect(await s.repo.db.query("select deleted_at from comments where id = $1", [comment_id])).toHaveLength(1);
    await settle();
    // The edit notifies the owner (once); deletes don't notify.
    expect(s.telegrams.slice(before)).toHaveLength(1);
    expect(s.telegrams.at(-1)).toContain(`${LUIS} (Codirector(a)) editó un comentario`);
  });

  it("only the opener or the owner can resolve; anyone who sees the thread can reopen", async () => {
    let res = await luis.send("POST", `/api/threads/${threadId}/resolve`, undefined, { "accept-language": "en" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/Only whoever opened the thread/);
    expect((await luis.json<{ thread: { can_resolve: boolean } }>(`/api/threads/${threadId}`)).thread.can_resolve).toBe(false);
    res = await ana.send("POST", `/api/threads/${threadId}/resolve`);
    expect(((await res.json()) as { thread: unknown }).thread).toMatchObject({ status: "resolved", resolved_by: ANA, can_resolve: true });
    res = await s.owner("/api/documents/thesis/threads?status=open");
    expect(((await res.json()) as { threads: unknown[] }).threads).toHaveLength(0);
    res = await luis.send("POST", `/api/threads/${threadId}/reopen`);
    expect(((await res.json()) as { thread: unknown }).thread).toMatchObject({ status: "open", resolved_by: null });
    res = await s.owner(`/api/threads/${threadId}/resolve`, { method: "POST" });
    expect(((await res.json()) as { thread: { status: string; resolved_by: string } }).thread).toMatchObject({ status: "resolved", resolved_by: "Eduardo Ejemplo" });
    res = await s.owner(`/api/threads/${threadId}/reopen`, { method: "POST" });
    expect(((await res.json()) as { thread: { status: string } }).thread.status).toBe("open");
  });

  it("visibility 'own' hides other reviewers' threads and comments, per document", async () => {
    let res = await luis.send("POST", "/api/documents/thesis/threads", { version: 1, page: 4, anchor: "point", rects: [{ x: 0.3, y: 0.4, w: 0, h: 0 }], body: "Falta una figura aquí." });
    const luisThread = ((await res.json()) as { thread: { id: number } }).thread.id;
    res = await s.ownerJson("POST", "/api/documents/thesis/threads", { version: 1, page: 5, anchor: "point", rects: [{ x: 0.2, y: 0.2, w: 0, h: 0 }], body: "¿Les parece bien esta conclusión?" });
    const ownerThread = ((await res.json()) as { thread: { id: number } }).thread.id;
    await luis.send("POST", `/api/threads/${ownerThread}/comments`, { body: "Opinión del codirector" });
    await ana.send("POST", `/api/threads/${ownerThread}/comments`, { body: "Opinión del director" });
    await luis.send("POST", `/api/threads/${ownerThread}/resolve`).then(async (r) => expect(r.status).toBe(403));
    await s.owner(`/api/threads/${ownerThread}/resolve`, { method: "POST" });
    // The co-director's own thread, resolved by him.
    await luis.send("POST", `/api/threads/${luisThread}/resolve`);
    // A thread in the report, where Ana is the only reviewer (visibility there stays "all").
    res = await ana.send("POST", "/api/documents/report/threads", { version: 1, page: 2, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "Report remark" });
    expect(res.status).toBe(201);

    type T = { id: number; resolved_by: string | null; comments: { author: { name: string }; body: string | null }[] };
    const list = async (b: Browser, doc = "thesis") => (await b.json<{ threads: T[] }>(`/api/documents/${doc}/threads?status=all`)).threads;
    expect((await list(ana)).length).toBe(3);
    expect((await s.ownerJson("PATCH", "/api/documents/thesis", { visibility: "own" })).status).toBe(200);
    const mine = await list(ana);
    expect(mine.map((t) => t.id).sort()).toEqual([threadId, ownerThread].sort());
    const ot = mine.find((t) => t.id === ownerThread)!;
    expect(ot.comments.map((c) => c.author.name)).toEqual(["Eduardo Ejemplo", ANA]);
    expect(JSON.stringify(mine)).not.toContain("Opinión del codirector");
    expect(JSON.stringify(mine)).not.toContain("Méndez");
    expect(ot.resolved_by).toBe("Eduardo Ejemplo");
    expect((await ana.json<{ thread: { comments: unknown[] } }>(`/api/threads/${ownerThread}`)).thread.comments).toHaveLength(2);
    // Counts follow the visibility too, and reviewers don't learn how many others there are.
    const extra = ((await (await luis.send("POST", "/api/documents/thesis/threads", { version: 1, page: 2, anchor: "point", rects: [{ x: 0.1, y: 0.1, w: 0, h: 0 }], body: "Otra" })).json()) as { thread: { id: number } }).thread.id;
    const { documents } = await ana.json<{ documents: Record<string, unknown>[] }>("/api/documents");
    const thesisDoc = documents.find((d) => d.slug === "thesis")!;
    expect(thesisDoc.open_threads).toBe(1);
    expect("reviewers" in thesisDoc).toBe(false);
    expect(((await (await s.owner("/api/documents/thesis")).json()) as { document: { open_threads: number; reviewers: number } }).document).toMatchObject({ open_threads: 2, reviewers: 2 });
    await s.repo.db.query("delete from comments where thread_id = $1", [extra]);
    await s.repo.db.query("delete from threads where id = $1", [extra]);
    const his = await list(luis);
    expect(his.map((t) => t.id).sort()).toEqual([luisThread, ownerThread].sort());
    expect(his.find((t) => t.id === luisThread)!.resolved_by).toBe(LUIS);
    expect((await ana.send("POST", `/api/threads/${luisThread}/comments`, { body: "x" })).status).toBe(404);
    expect((await ana.get(`/api/threads/${luisThread}`)).status).toBe(404);
    // Other documents keep their own setting.
    expect((await list(ana, "report")).map((t) => t.comments[0]!.body)).toEqual(["Report remark"]);
    // The owner still sees everything.
    const all = (await (await s.owner(`/api/threads/${ownerThread}`)).json()) as { thread: { comments: unknown[] } };
    expect(all.thread.comments).toHaveLength(3);
    await s.ownerJson("PATCH", "/api/documents/thesis", { visibility: "all" });
    expect((await list(ana)).length).toBe(3);
    await s.owner(`/api/threads/${ownerThread}/reopen`, { method: "POST" });
  });

  it("serves the PDF only to whoever may see the document", async () => {
    const res = await ana.get("/api/documents/thesis/versions/1/pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="thesis-v1.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("versions and changes", () => {
  it("publishing v2 emails the document's opted-in reviewers without their link, in its language, and computes the diff", async () => {
    const mailsBefore = s.mails.length;
    const res = await s.publish("thesis", sampleThesis(true), sampleProgress(true), "Atendí los comentarios del capítulo 1");
    expect(res.status).toBe(201);
    await settle();
    const newMails = s.mails.slice(mailsBefore);
    expect(newMails.map((m) => m.to)).toEqual(["director@example.test"]);
    expect(newMails[0]!.subject).toContain("Nueva versión (v2)");
    expect(newMails[0]!.text).not.toContain("/a/");
    expect(newMails[0]!.text).toContain("Atendí los comentarios");
    expect(newMails[0]!.text).toContain(`${ORIGIN}/d/thesis/v/2`);

    const diff = (await ana.json<{ diff: { previous: number; mode: string; sections: { id: string; words_delta: number; added: number; hunks: { op: string; text: string }[][] }[] } }>("/api/documents/thesis/versions/2/diff")).diff;
    expect(diff.previous).toBe(1);
    expect(diff.mode).toBe("sections");
    const intro = diff.sections.find((c) => c.id === "01-introduccion")!;
    expect(intro.words_delta).toBe(350);
    expect(intro.added).toBeGreaterThan(0);
    expect(intro.hunks.flat().some((o) => o.op === "add" && o.text.includes("anonimizar los datos de viajes"))).toBe(true);
    expect(diff.sections.find((c) => c.id === "02-marco-teorico")!.hunks).toEqual([]);

    // Stored with the version, not recomputed.
    const doc = (await s.repo.documentBySlug("thesis"))!;
    const v2 = (await s.repo.getVersion(doc.id, 2))!;
    expect(await s.repo.storedDiff(v2.id)).toMatchObject({ previous: 1 });
    await s.repo.db.query("update version_diffs set diff = jsonb_set(diff, '{mode}', '\"stored\"') where version_id = $1", [v2.id]);
    expect((await ana.json<{ diff: { mode: string } }>("/api/documents/thesis/versions/2/diff")).diff.mode).toBe("stored");
    await s.repo.db.query("update version_diffs set diff = jsonb_set(diff, '{mode}', '\"sections\"') where version_id = $1", [v2.id]);

    const text = await (await ana.get("/d/thesis/v/2/changes")).text();
    expect(text).toContain("Avance por sección");
    expect(text).toContain("+350");
    expect((await ana.get("/d/thesis/v/latest")).headers.get("location")).toBe("/d/thesis/v/2");
  });

  it("comments stay with the version they were made on", async () => {
    const v1 = (await (await s.owner("/api/documents/thesis/threads?version=1&status=all")).json()) as { threads: unknown[] };
    const v2 = (await (await s.owner("/api/documents/thesis/threads?version=latest&status=all")).json()) as { threads: unknown[] };
    expect(v1.threads.length).toBe(3);
    expect(v2.threads.length).toBe(0);
  });
});

describe("archived documents", () => {
  it("are read-only for everyone and listed apart", async () => {
    expect((await s.ownerJson("POST", "/api/documents/report/archive", {})).status).toBe(200);
    const body = { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" };
    let res = await ana.send("POST", "/api/documents/report/threads", body, { "accept-language": "en" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/archived/);
    expect((await s.ownerJson("POST", "/api/documents/report/threads", body)).status).toBe(409);
    expect((await s.publish("report")).status).toBe(409);
    const [t] = (await ana.json<{ threads: { id: number }[] }>("/api/documents/report/threads")).threads;
    expect((await ana.send("POST", `/api/threads/${t!.id}/comments`, { body: "x" })).status).toBe(409);
    // Still readable.
    expect((await ana.get("/d/report/v/1")).status).toBe(200);
    expect(await (await ana.get("/d/report/v/1")).text()).toContain('data-archived="1"');
    expect(await (await s.owner("/", { headers: { "accept-language": "en" } })).text()).toContain("1 archived document");
    expect((await s.ownerJson("POST", "/api/documents/report/unarchive", {})).status).toBe(200);
    expect((await ana.send("POST", "/api/documents/report/threads", body)).status).toBe(201);
  });
});

describe("owner web login and dashboard", () => {
  it("logs in with the token once and gets a session; a wrong token is rejected", async () => {
    const b = new Browser(s.url);
    const form = await fetch(s.url + "/login");
    const pre = form.headers.getSetCookie()[0]!.split(";")[0]!;
    const preValue = pre.split("=")[1]!;
    const post = (token: string, origin = ORIGIN) =>
      fetch(s.url + "/login", {
        method: "POST",
        redirect: "manual",
        headers: { cookie: pre, origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: preValue, token }).toString(),
      });
    expect((await post("wrong")).status).toBe(401);
    expect((await post(OWNER_TOKEN, "https://evil.example")).status).toBe(403);
    const ok = await post(OWNER_TOKEN);
    expect(ok.status).toBe(303);
    b.cookie = ok.headers.getSetCookie().find((c) => c.startsWith("__Host-dr_session="))!.split(";")[0]!;
    const text = await (await b.get("/", { "accept-language": "en" })).text();
    expect(text).toContain("<h1>Documents</h1>");
    expect(text).toContain("Método computacional");
    expect(text).toContain(LUIS);
    const manage = await (await b.get("/d/thesis/manage", { "accept-language": "en" })).text();
    expect(manage).toContain("Codirector(a)");
    expect(manage).toContain('list="role-suggestions"');
    // Role suggestions in the document's language (the thesis is in Spanish).
    expect(manage).toContain('<option value="Codirector(a)">');
    expect(await (await b.get("/d/report/manage", { "accept-language": "en" })).text()).toContain('<option value="Co-director">');
    expect(s.logs.join("\n")).not.toContain(OWNER_TOKEN);
  });

  it("rate-limits the login endpoint", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await fetch(s.url + "/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "token=x" })).status;
    }
    expect(last).toBe(429);
  });
});

describe("revocation and rotation", () => {
  it("revoking ends the access to that document only; sessions opened only with that link end", async () => {
    // Ana's browser holds both links; a second browser has only the report link.
    const onlyReport = await s.browser(anaReportLink);
    expect((await onlyReport.get("/d/thesis/v/1")).status).toBe(200);
    expect((await s.ownerJson("POST", `/api/invitations/${anaReportInv}/revoke`, {})).status).toBe(200);
    expect((await onlyReport.get("/api/me")).status).toBe(401);
    expect((await ana.get("/api/me")).status).toBe(200);
    expect((await ana.get("/d/report/v/1")).status).toBe(404);
    expect((await ana.get("/d/thesis/v/1")).status).toBe(200);
    expect((await fetch(s.url + new URL(anaReportLink).pathname, { redirect: "manual" })).status).toBe(404);
  });

  it("rotating gives a new link and ends the sessions opened with the old one", async () => {
    const res = await s.ownerJson("POST", `/api/invitations/${anaThesisInv}/rotate`, { send_link: true });
    const r = (await res.json()) as { link: string; email: { sent: boolean } };
    expect(r.link).not.toBe(anaThesisLink);
    expect(r.email.sent).toBe(true);
    expect(s.mails.at(-1)!.to).toBe("director@example.test");
    expect(s.mails.at(-1)!.text).toContain(r.link);
    expect(s.mails.at(-1)!.subject).toContain("Su enlace para revisar el documento");
    expect((await ana.get("/api/me")).status).toBe(401);
    expect((await fetch(s.url + new URL(anaThesisLink).pathname, { redirect: "manual" })).status).toBe(404);
    ana = await s.browser(r.link);
    expect(ana.csrf).toHaveLength(43);
    anaThesisLink = r.link;
    expect(s.logs.join("\n")).not.toContain(r.link.split("/").pop()!);
    // Rotating a revoked invitation reactivates it.
    const again = (await (await s.ownerJson("POST", `/api/invitations/${anaReportInv}/rotate`, {})).json()) as { link: string; invitation: { active: boolean } };
    expect(again.invitation.active).toBe(true);
    expect((await ana.get("/d/report/v/1")).status).toBe(200);
  });
});

describe("HTML form posts that carry Origin: null", () => {
  it("accept Origin: null only with Sec-Fetch-Site: same-origin", async () => {
    const fresh = await startTestServer();
    try {
      const f = await fetch(fresh.url + "/login");
      const pre = f.headers.getSetCookie()[0]!.split(";")[0]!;
      const post = (site: string) =>
        fetch(fresh.url + "/login", {
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

describe("the owner's client", () => {
  it("publishes and lists with the owner token", async () => {
    const { Client } = await import("../src/client.js");
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(s.dir, "t.pdf"), sampleThesis(true));
    await writeFile(join(s.dir, "a.json"), JSON.stringify(sampleProgress(true)));
    const client = new Client({ url: s.url, token: OWNER_TOKEN });
    const r = await client.publish("thesis", join(s.dir, "t.pdf"), { path: join(s.dir, "a.json") }, "from the client");
    expect(r.version.number).toBe(3);
    const { threads } = await client.threads("thesis", { status: "all" });
    expect(threads.length).toBeGreaterThan(0);
    await expect(new Client({ url: s.url, token: "nope" }).threads("thesis", {})).rejects.toThrow(/Invalid token/);
    await expect(client.threads("nope", {})).rejects.toThrow(/No such document/);
  });
});

describe("untrusted text", () => {
  it("stores comments without control or bidi characters", async () => {
    const res = await luis.send("POST", "/api/documents/thesis/threads", {
      version: 1,
      page: 2,
      anchor: "point",
      rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }],
      body: "ok \u001b[2J\u001b]0;x\u0007 fin\u0000\r\nlínea 2",
    });
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as { thread: { comments: { body: string }[] } };
    expect(thread.comments[0]!.body).toBe("ok [2J]0;x fin\nlínea 2");
  });

  it("names and titles are one line", async () => {
    const res = await s.ownerJson("POST", "/api/people", { name: "Dra.\nB", email: "" });
    expect(((await res.json()) as { person: { name: string } }).person.name).toBe("Dra. B");
  });
});

describe("owner sessions", () => {
  it("stop working when the owner token changes", async () => {
    const { Repo, ownerSessionFingerprint } = await import("../src/repo.js");
    const { sha256Hex } = await import("../src/server/crypto.js");
    const before = new Repo(s.repo.db, "x", ownerSessionFingerprint(sha256Hex(OWNER_TOKEN)));
    const after = new Repo(s.repo.db, "x", ownerSessionFingerprint(sha256Hex("dr_owner_rotated")));
    const sess = await before.createSession("owner", null, 3600_000);
    expect(await before.getSession(sess.id, () => 3600_000)).not.toBeNull();
    expect(await after.getSession(sess.id, () => 3600_000)).toBeNull();
    // ...and the row is gone, even for the old token.
    expect(await before.getSession(sess.id, () => 3600_000)).toBeNull();
    const other = await before.createSession("owner", null, 3600_000);
    expect(await after.purgeStaleOwnerSessions()).toBeGreaterThanOrEqual(1);
    expect(await before.getSession(other.id, () => 3600_000)).toBeNull();
  });

  it("«close all sessions» closes the owner's web sessions and, if asked, the reviewers'", async () => {
    const fresh = await startTestServer();
    try {
      const login = async () => {
        const f = await fetch(fresh.url + "/login");
        const pre = f.headers.getSetCookie()[0]!.split(";")[0]!;
        const ok = await fetch(fresh.url + "/login", {
          method: "POST",
          redirect: "manual",
          headers: { cookie: pre, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ _csrf: pre.split("=")[1]!, token: OWNER_TOKEN }).toString(),
        });
        return ok.headers.getSetCookie().find((c) => c.startsWith("__Host-dr_session="))!.split(";")[0]!;
      };
      await fresh.createDoc("d");
      const { link, invitationId } = await fresh.invite("d", { name: "Dr. X" });
      const reviewer = await fresh.browser(link);
      const me = (cookie: string) => fetch(fresh.url + "/api/me", { headers: { cookie } }).then((r) => r.status);
      const web1 = await login();
      const web2 = await login();
      let r = await fresh.ownerJson("POST", "/api/sessions/close-all", {});
      expect(((await r.json()) as { closed: unknown }).closed).toEqual({ owner: 2, reviewers: 0 });
      expect([await me(web1), await me(web2), await me(reviewer.cookie)]).toEqual([401, 401, 200]);
      const web3 = await login();
      const csrf = ((await (await fetch(fresh.url + "/api/me", { headers: { cookie: web3 } })).json()) as { csrf: string }).csrf;
      r = await fetch(fresh.url + "/api/sessions/close-all", {
        method: "POST",
        headers: { cookie: web3, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ reviewers: true }),
      });
      expect(((await r.json()) as { closed: unknown }).closed).toEqual({ owner: 1, reviewers: 1 });
      expect(r.headers.getSetCookie()[0]).toMatch(/^__Host-dr_session=; .*Max-Age=0/);
      expect([await me(web3), await me(reviewer.cookie)]).toEqual([401, 401]);
      // Reviewers can't do it.
      const rot = (await (await fresh.ownerJson("POST", `/api/invitations/${invitationId}/rotate`, {})).json()) as { link: string };
      const again = await fresh.browser(rot.link);
      expect((await again.send("POST", "/api/sessions/close-all", {})).status).toBe(403);
    } finally {
      await fresh.stop();
    }
  });
});

describe("write limits", () => {
  it("cap each reviewer's comments per day over all their documents, and don't reset with a new session", async () => {
    const fresh = await startTestServer({ MAX_REVIEWER_COMMENTS_PER_DAY: "3" });
    try {
      await fresh.createDoc("a");
      await fresh.createDoc("b");
      expect((await fresh.publish("a")).status).toBe(201);
      expect((await fresh.publish("b")).status).toBe(201);
      const inv = await fresh.invite("a", { name: "Dr. X" });
      const invB = await fresh.invite("b", { person_id: inv.personId });
      const t = { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" };
      const first = await fresh.browser(inv.link);
      const post = (b: Browser, doc: string) => b.send("POST", `/api/documents/${doc}/threads`, t).then((r) => r.status);
      expect([await post(first, "a"), await post(first, "a"), await post(first, "b"), await post(first, "b")]).toEqual([201, 201, 201, 429]);
      const second = await fresh.browser(invB.link);
      expect(await post(second, "a")).toBe(429);
      // The owner has no daily cap.
      expect((await fresh.ownerJson("POST", "/api/documents/a/threads", t)).status).toBe(201);
    } finally {
      await fresh.stop();
    }
  });
});

describe("people: editing, invitations' state, delete and archive", () => {
  let f: TestServer;
  const point = { version: 1, page: 1, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" };
  beforeAll(async () => {
    f = await startTestServer();
    await f.createDoc("a", { language: "en" });
    await f.createDoc("b", { language: "es" });
    expect((await f.publish("a")).status).toBe(201);
  });
  afterAll(async () => {
    await f.stop();
  });

  it("the owner adds, changes and removes an existing person's email and preferences (validated)", async () => {
    const inv = await f.invite("a", { name: "Dr. Sin Correo" });
    const patch = (body: unknown) => f.ownerJson("PATCH", `/api/people/${inv.personId}`, body);
    let r = await patch({ email: "nuevo@example.test" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { person: { email: string } }).person.email).toBe("nuevo@example.test");
    expect((await patch({ email: "not an email" })).status).toBe(400);
    expect((await patch({ email: "a@b.c‮" })).status).toBe(200); // bidi stripped, then valid
    r = await patch({ name: "Dr. Con\nCorreo", email: "otro@example.test", notify_replies: "daily", notify_versions: true });
    expect(((await r.json()) as { person: unknown }).person).toMatchObject({ name: "Dr. Con Correo", email: "otro@example.test", notify_replies: "daily", notify_versions: true });
    expect((await patch({ notify_replies: "hourly" })).status).toBe(400);
    expect((await patch({ name: "" })).status).toBe(400);
    r = await patch({ email: "" });
    expect(((await r.json()) as { person: { email: string | null } }).person.email).toBeNull();
    expect((await f.ownerJson("PATCH", "/api/people/9999", { email: "" })).status).toBe(404);
  });

  it("a person's page shows the form, each invitation's state and its actions; owner only", async () => {
    const inv = await f.invite("a", { name: "Ing. <b>Pérez</b>", email: "perez@example.test" });
    await f.invite("b", { person_id: inv.personId, role: "Cliente" });
    let page = await (await f.owner(`/people/${inv.personId}`)).text();
    expect(page).toContain("Ing. &lt;b&gt;Pérez&lt;/b&gt;");
    expect(page).not.toContain("<b>Pérez</b>");
    expect(page).toContain('id="person-edit-form"');
    expect(page).toContain('value="perez@example.test"');
    expect(page).toContain('data-action="email-link"');
    expect(page).toContain("Not opened yet");
    expect(page).toContain('id="delete-person"');
    // Opening the link makes it "Active"; revoking makes it "Revoked".
    const b = await f.browser(inv.link);
    expect((await b.get("/people/" + inv.personId)).status).toBe(403);
    expect((await b.get("/api/people/" + inv.personId)).status).toBe(403);
    const api = (await (await f.owner(`/api/people/${inv.personId}`)).json()) as { person: { comments: number; invitations: { document: string; state: string }[] } };
    expect(api.person.comments).toBe(0);
    expect(api.person.invitations.map((i) => [i.document, i.state]).sort()).toEqual([
      ["a", "active"],
      ["b", "unused"],
    ]);
    const bInv = (await (await f.owner("/api/documents/b/invitations")).json()) as { invitations: { id: number; person: { id: number } }[] };
    const revokeId = bInv.invitations.find((i) => i.person.id === inv.personId)!.id;
    await f.ownerJson("POST", `/api/invitations/${revokeId}/revoke`, {});
    page = await (await f.owner(`/people/${inv.personId}`)).text();
    expect(page).toContain("Revoked");
    expect(page).toContain("Reactivate with a new link");
    // The document's page links to the person and offers the email action.
    const manage = await (await f.owner("/d/a/manage")).text();
    expect(manage).toContain(`href="/people/${inv.personId}"`);
    expect(manage).toContain('data-action="email-link"');
    expect((await f.owner("/people/9999")).status).toBe(404);
    expect((await f.owner("/people/x")).status).toBe(400);
    // Spanish pages.
    const es = await (await f.owner(`/people/${inv.personId}`, { headers: { "accept-language": "es" } })).text();
    expect(es).toContain("Reactivar con enlace nuevo");
    expect(es).toContain("Eliminar persona");
  });

  it("«send link by email» needs an address and the SMTP server, and changes nothing otherwise", async () => {
    const inv = await f.invite("a", { name: "Sin Correo" });
    const res = await f.ownerJson("POST", `/api/invitations/${inv.invitationId}/rotate`, { send_link: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no email address");
    // The old link still works: nothing was rotated.
    expect((await f.browser(inv.link)).csrf).toHaveLength(43);
    expect((await f.ownerJson("POST", "/api/documents/b/invitations", { name: "Nadie", send_link: true })).status).toBe(409);
    expect(((await (await f.owner("/api/people")).json()) as { people: { name: string }[] }).people.map((p) => p.name)).not.toContain("Nadie");

    await f.ownerJson("PATCH", `/api/people/${inv.personId}`, { email: "ya@example.test" });
    const ok = (await (await f.ownerJson("POST", `/api/invitations/${inv.invitationId}/rotate`, { send_link: true })).json()) as { link: string; email: { sent: boolean } };
    expect(ok.email.sent).toBe(true);
    expect(f.mails.at(-1)!.to).toBe("ya@example.test");
    expect(f.mails.at(-1)!.text).toContain(ok.link);

    const noMail = await startTestServer({}, { mail: false });
    try {
      await noMail.createDoc("a");
      const i = await noMail.invite("a", { name: "X", email: "x@example.test" });
      const r = await noMail.ownerJson("POST", `/api/invitations/${i.invitationId}/rotate`, { send_link: true });
      expect(r.status).toBe(409);
      expect((await noMail.browser(i.link)).csrf).toHaveLength(43);
      const page = await (await noMail.owner(`/people/${i.personId}`)).text();
      expect(page).toContain("SMTP is not configured");
    } finally {
      await noMail.stop();
    }
  });

  it("a person who never commented can be deleted: invitations, links and sessions go too", async () => {
    const inv = await f.invite("a", { name: "Borrable", email: "borrable@example.test" });
    await f.invite("b", { person_id: inv.personId });
    const b = await f.browser(inv.link);
    expect((await b.get("/api/me")).status).toBe(200);
    // CSRF and owner-only apply.
    expect((await b.send("DELETE", `/api/people/${inv.personId}`)).status).toBe(403);
    const owner = await f.browser();
    expect((await f.owner(`/api/people/${inv.personId}`)).status).toBe(200);
    expect((await owner.send("DELETE", `/api/people/${inv.personId}`)).status).toBe(401);
    expect((await f.ownerJson("DELETE", `/api/people/${inv.personId}`)).status).toBe(200);
    expect((await f.owner(`/api/people/${inv.personId}`)).status).toBe(404);
    expect((await b.get("/api/me")).status).toBe(401);
    expect((await fetch(f.url + new URL(inv.link).pathname, { redirect: "manual" })).status).toBe(404);
    expect((await f.ownerJson("DELETE", `/api/people/${inv.personId}`)).status).toBe(404);
    expect(f.logs.join("\n")).toContain(`person #${inv.personId} deleted`);
  });

  it("someone with comments can't be deleted: archiving revokes everything and hides them; unarchiving doesn't reactivate", async () => {
    const inv = await f.invite("a", { name: "Comentarista", email: "c@example.test" });
    const invB = await f.invite("b", { person_id: inv.personId });
    const b = await f.browser(inv.link);
    expect((await b.send("POST", "/api/documents/a/threads", point)).status).toBe(201);
    const del = await f.ownerJson("DELETE", `/api/people/${inv.personId}`);
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: string }).error).toContain("archive");
    let page = await (await f.owner(`/people/${inv.personId}`)).text();
    expect(page).not.toContain('id="delete-person"');
    expect(page).toContain('id="archive-person"');

    expect((await f.ownerJson("POST", `/api/people/${inv.personId}/archive`, {})).status).toBe(200);
    expect((await b.get("/api/me")).status).toBe(401);
    expect((await fetch(f.url + new URL(invB.link).pathname, { redirect: "manual" })).status).toBe(404);
    const listed = async (q = "") =>
      ((await (await f.owner(`/api/people${q}`)).json()) as { people: { id: number; archived: boolean; invitations: { active: boolean }[] }[] }).people.find((p) => p.id === inv.personId);
    expect(await listed()).toBeUndefined();
    const archived = (await listed("?archived=1"))!;
    expect(archived.archived).toBe(true);
    expect(archived.invitations.every((i) => !i.active)).toBe(true);
    // Hidden from the lists, not from their own page; no actions on their invitations.
    const manage = await (await f.owner("/d/a/manage")).text();
    expect(manage).not.toContain("Comentarista");
    expect(manage).toContain("1 archived person is not shown.");
    const dash = await (await f.owner("/")).text();
    expect(dash).toContain("1 archived person");
    page = await (await f.owner(`/people/${inv.personId}`)).text();
    expect(page).toContain('id="unarchive-person"');
    expect(page).not.toContain('data-action="rotate"');
    // An archived person can't be invited or get a new link.
    expect((await f.ownerJson("POST", `/api/invitations/${inv.invitationId}/rotate`, {})).status).toBe(409);
    expect((await f.ownerJson("POST", "/api/documents/b/invitations", { person_id: inv.personId })).status).toBe(409);
    // The comment stays.
    const threads = (await (await f.owner("/api/documents/a/threads?status=all")).json()) as { threads: { comments: { author: { name: string } }[] }[] };
    expect(threads.threads.some((t) => t.comments[0]!.author.name === "Comentarista")).toBe(true);

    expect((await f.ownerJson("POST", `/api/people/${inv.personId}/unarchive`, {})).status).toBe(200);
    const back = (await listed())!;
    expect(back.archived).toBe(false);
    expect(back.invitations.every((i) => !i.active)).toBe(true);
    const again = (await (await f.ownerJson("POST", `/api/invitations/${inv.invitationId}/rotate`, {})).json()) as { invitation: { active: boolean } };
    expect(again.invitation.active).toBe(true);
    expect((await f.ownerJson("POST", "/api/people/9999/archive", {})).status).toBe(404);
  });
});
