// Reply notifications for directors, edit notifications, digests that retry,
// the directors' «Notificaciones» page and sliding cookies.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Notifier, type Mail } from "../src/notify/notify.js";
import { runDigest, runDirectorDigests } from "../src/server/main.js";
import { sampleAvance, sampleThesis } from "./fixtures/make-pdf.mjs";
import { OWNER_TOKEN, settle, startTestServer, type TestServer } from "./helpers.js";

const ORIGIN = "https://revision.example.test";
let s: TestServer;

const bearer = { authorization: `Bearer ${OWNER_TOKEN}` };
const ownerJson = (method: string, path: string, body: unknown) =>
  fetch(s.url + path, { method, headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) });

interface Dir {
  id: number;
  cookie: string;
  csrf: string;
  send(method: string, path: string, body?: unknown): Promise<Response>;
}

async function addDirector(name: string, email: string, notify_replies: string): Promise<Dir> {
  const r = (await (await ownerJson("POST", "/api/directors", { name, email, notify_replies })).json()) as {
    link: string;
    director: { id: number };
  };
  const cookie = (await fetch(s.url + new URL(r.link).pathname, { redirect: "manual" })).headers.getSetCookie()[0]!.split(";")[0]!;
  const csrf = ((await (await fetch(s.url + "/api/me", { headers: { cookie } })).json()) as { csrf: string }).csrf;
  return {
    id: r.director.id,
    cookie,
    csrf,
    send: (method, path, body) =>
      fetch(s.url + path, {
        method,
        redirect: "manual",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
  };
}

const point = (page: number, body: string) => ({ version: 1, page, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body });
const mailsTo = (to: string, from: number) => s.mails.slice(from).filter((m) => m.to === to);

let A: Dir, B: Dir, C: Dir;
let t1 = 0;

beforeAll(async () => {
  s = await startTestServer();
  const f = new FormData();
  f.set("pdf", new Blob([sampleThesis() as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), "t.pdf");
  f.set("avance", new Blob([JSON.stringify(sampleAvance())]), "a.json");
  expect((await fetch(s.url + "/api/versions", { method: "POST", headers: bearer, body: f })).status).toBe(201);
  A = await addDirector("Dr. A", "a@example.test", "instant");
  B = await addDirector("Dra. B", "b@example.test", "instant");
  C = await addDirector("Dr. C", "c@example.test", "daily");
});
afterAll(async () => {
  await s.stop();
});

describe("reply notifications to directors", () => {
  it("email the participants who chose «al momento», never the author of the reply, never the secret link", async () => {
    t1 = ((await (await A.send("POST", "/api/threads", point(1, "¿Está bien este párrafo?"))).json()) as { thread: { id: number } }).thread.id;
    await settle();
    let from = s.mails.length;
    // A new thread notifies the owner only.
    expect(mailsTo("a@example.test", 0)).toEqual([]);

    expect((await B.send("POST", `/api/threads/${t1}/comments`, { body: "Yo lo dejaría así." })).status).toBe(201);
    await settle();
    let a = mailsTo("a@example.test", from);
    expect(a).toHaveLength(1);
    expect(a[0]!.subject).toContain("Respuesta de Dra. B");
    expect(a[0]!.text).toContain("Yo lo dejaría así.");
    expect(a[0]!.text).toContain(`${ORIGIN}/v/1#hilo-${t1}`);
    expect(a[0]!.text).toContain("use su enlace personal");
    expect(a[0]!.text).not.toContain("/acceso/");
    expect(mailsTo("b@example.test", from)).toEqual([]);
    expect(mailsTo("c@example.test", from)).toEqual([]); // not a participant

    from = s.mails.length;
    expect((await ownerJson("POST", `/api/threads/${t1}/comments`, { body: "Gracias a ambos." })).status).toBe(201);
    await settle();
    expect(mailsTo("a@example.test", from)).toHaveLength(1);
    expect(mailsTo("b@example.test", from)).toHaveLength(1);
    expect(mailsTo("c@example.test", from)).toEqual([]);
  });

  it("respect the visibility setting: no email about a comment the director can't see", async () => {
    await ownerJson("PUT", "/api/settings", { comments_visibility: "own" });
    try {
      let from = s.mails.length;
      expect((await B.send("POST", `/api/threads/${t1}/comments`, { body: "Comentario de B en modo privado" })).status).toBe(404);
      // B can't even see A's thread now; an owner reply reaches A only.
      expect((await ownerJson("POST", `/api/threads/${t1}/comments`, { body: "Respuesta del autor" })).status).toBe(201);
      await settle();
      expect(mailsTo("a@example.test", from)).toHaveLength(1);
      expect(mailsTo("b@example.test", from)).toEqual([]);
      // An owner thread where both take part: A doesn't hear about B's reply.
      const t = ((await (await ownerJson("POST", "/api/threads", point(2, "¿Qué opinan?"))).json()) as { thread: { id: number } }).thread.id;
      await A.send("POST", `/api/threads/${t}/comments`, { body: "Opina A" });
      await settle();
      from = s.mails.length;
      await B.send("POST", `/api/threads/${t}/comments`, { body: "Opina B" });
      await settle();
      expect(mailsTo("a@example.test", from)).toEqual([]);
      expect(s.mails.slice(from).some((m) => m.text.includes("Opina B") && m.to !== "autor@example.test")).toBe(false);
    } finally {
      await ownerJson("PUT", "/api/settings", { comments_visibility: "all" });
    }
  });

  it("«Nunca» means no email", async () => {
    await ownerJson("PATCH", `/api/directors/${B.id}`, { notify_replies: "never" });
    const from = s.mails.length;
    await A.send("POST", `/api/threads/${t1}/comments`, { body: "Una más" });
    await settle();
    expect(mailsTo("b@example.test", from)).toEqual([]);
    expect((await ownerJson("PATCH", `/api/directors/${B.id}`, { notify_replies: "a veces" })).status).toBe(400);
  });
});

describe("the directors' «Notificaciones» page", () => {
  it("lets a director choose for themselves (CSRF-protected form)", async () => {
    let res = await fetch(s.url + "/notificaciones", { headers: { cookie: C.cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("c@example.test");
    expect(text).toMatch(/value="daily" checked/);
    const post = (csrf: string, replies: string, versions?: string) =>
      fetch(s.url + "/notificaciones", {
        method: "POST",
        redirect: "manual",
        headers: { cookie: C.cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: csrf, replies, ...(versions ? { versions } : {}) }).toString(),
      });
    expect((await post("wrong", "instant")).status).toBe(403);
    expect((await post(C.csrf, "sometimes")).status).toBe(400);
    res = await post(C.csrf, "instant", "1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/notificaciones?guardado=1");
    const me = (await (await fetch(s.url + "/api/me", { headers: { cookie: C.cookie } })).json()) as { notifications: unknown };
    expect(me.notifications).toEqual({ replies: "instant", versions: true, email: true });
    await post(C.csrf, "daily");
    // The page links from the nav; the owner has no such page.
    expect(await (await fetch(s.url + "/v/1", { headers: { cookie: C.cookie } })).text()).toContain('href="/notificaciones"');
    expect((await fetch(s.url + "/notificaciones", { headers: bearer, redirect: "manual" })).status).toBe(303);
  });
});

describe("digests", () => {
  const config = loadConfig({ DIGEST_HOUR: "8", TZ: "America/Mexico_City" });
  const at = (h: number) => {
    const d = new Date();
    d.setUTCHours(h + 6, 30, 0, 0); // h:30 in Mexico City (UTC-6)
    return d;
  };
  const notifier = (mailer: { send(m: Mail): Promise<void> }, telegram: { send(t: string): Promise<void> } | null = null) =>
    new Notifier({ publicUrl: ORIGIN, thesisTitle: async () => "T", telegram, mailer, ownerEmail: "", instant: false, log: () => undefined });

  it("a director's daily digest: replies by others in their threads, once a day, retried after a failure", async () => {
    // C takes part in a thread; the owner and A reply.
    const t = ((await (await C.send("POST", "/api/threads", point(3, "Revise la figura 2"))).json()) as { thread: { id: number } }).thread.id;
    await ownerJson("POST", `/api/threads/${t}/comments`, { body: "Ya la cambié" });
    await A.send("POST", `/api/threads/${t}/comments`, { body: "Se ve mejor" });
    await s.repo.db.query("update comments set created_at = $1 where thread_id = $2", [new Date(at(9).getTime() - 3600_000), t]);
    let fail = true;
    const sent: Mail[] = [];
    const n = notifier({
      send: async (m) => {
        if (fail) throw new Error("SMTP 451");
        sent.push(m);
      },
    });
    const logs: string[] = [];
    expect(await runDirectorDigests(config, s.repo, n, at(7))).toBe(0); // before 8:00
    expect(await runDirectorDigests(config, s.repo, n, at(9), (m) => void logs.push(m))).toBe(0);
    expect(logs[0]).toMatch(/director digest failed for director #\d+: SMTP 451/);
    fail = false;
    expect(await runDirectorDigests(config, s.repo, n, new Date(at(9).getTime() + 300_000))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("c@example.test");
    expect(sent[0]!.text).toContain("Ya la cambié");
    expect(sent[0]!.text).toContain("Se ve mejor");
    expect(sent[0]!.text).not.toContain("Revise la figura 2"); // their own comment
    expect(sent[0]!.text).not.toContain("/acceso/");
    expect(await runDirectorDigests(config, s.repo, n, new Date(at(9).getTime() + 600_000))).toBe(0); // same day
  });

  it("the owner's digest marks the day only after it went out", async () => {
    await s.repo.db.query("delete from digest_runs");
    await s.repo.db.query("update comments set created_at = $1", [new Date(at(9).getTime() - 3600_000)]);
    let fail = true;
    const tg: string[] = [];
    const n = notifier({ send: async () => undefined }, {
      send: async (t) => {
        if (fail) throw new Error("HTTP 502");
        tg.push(t);
      },
    });
    expect(await runDigest(config, s.repo, n, at(9))).toBe(false);
    expect(await s.repo.digestDone(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(at(9)))).toBe(false);
    fail = false;
    expect(await runDigest(config, s.repo, n, new Date(at(9).getTime() + 300_000))).toBe(true);
    expect(tg[0]).toMatch(/Resumen diario/);
    expect(await runDigest(config, s.repo, n, new Date(at(9).getTime() + 600_000))).toBe(false);
  });
});

describe("edits", () => {
  it("notify the owner when a director edits a comment, and keep the previous texts", async () => {
    const r = (await (await A.send("POST", `/api/threads/${t1}/comments`, { body: "Primera redacción" })).json()) as { comment_id: number };
    await settle();
    const before = s.telegrams.length;
    expect((await A.send("PATCH", `/api/comments/${r.comment_id}`, { body: "Segunda redacción" })).status).toBe(200);
    expect((await A.send("PATCH", `/api/comments/${r.comment_id}`, { body: "Tercera redacción" })).status).toBe(200);
    await settle();
    const msgs = s.telegrams.slice(before);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("Dr. A editó un comentario");
    expect(msgs[0]).toMatch(/Antes:\nPrimera redacción\n\nAhora:\nSegunda redacción/);
    const edits = (await (await fetch(s.url + `/api/comments/${r.comment_id}/edits`, { headers: bearer })).json()) as { edits: { body: string }[] };
    expect(edits.edits.map((e) => e.body)).toEqual(["Segunda redacción", "Primera redacción"]);
    expect((await A.send("GET", `/api/comments/${r.comment_id}/edits`)).status).toBe(403);
    // The owner's own edits don't notify.
    const o = (await (await ownerJson("POST", `/api/threads/${t1}/comments`, { body: "x" })).json()) as { comment_id: number };
    await settle();
    const n = s.telegrams.length;
    await ownerJson("PATCH", `/api/comments/${o.comment_id}`, { body: "y" });
    await settle();
    expect(s.telegrams.length).toBe(n);
  });
});

describe("sessions", () => {
  it("the cookie's Max-Age is extended with the server-side session", async () => {
    let res = await fetch(s.url + "/api/me", { headers: { cookie: A.cookie } });
    expect(res.headers.getSetCookie()).toEqual([]);
    await s.repo.db.query("update sessions set last_seen_at = now() - interval '2 hours' where director_id = $1", [A.id]);
    res = await fetch(s.url + "/api/me", { headers: { cookie: A.cookie } });
    const set = res.headers.getSetCookie()[0]!;
    expect(set.split(";")[0]).toBe(A.cookie);
    expect(set).toMatch(new RegExp(`Max-Age=${180 * 24 * 3600}; Secure; SameSite=Lax; HttpOnly`));
  });
});
