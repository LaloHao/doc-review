// Reply notifications for reviewers, edit notifications, digests that retry,
// the reviewers' Notifications page and sliding cookies.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Notifier, type Mail } from "../src/notify/notify.js";
import { runDigest, runReviewerDigests } from "../src/server/main.js";
import { Browser, ORIGIN, settle, startTestServer, type TestServer } from "./helpers.js";

let s: TestServer;

const point = (page: number, body: string, version = 1) => ({ version, page, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body });
const mailsTo = (to: string, from: number) => s.mails.slice(from).filter((m) => m.to === to);

interface R {
  b: Browser;
  personId: number;
}
let A: R, B: R, C: R;
let t1 = 0;

async function reviewer(doc: string, name: string, email: string, notify_replies: string): Promise<R> {
  const inv = await s.invite(doc, { name, email });
  await s.ownerJson("PATCH", `/api/people/${inv.personId}`, { notify_replies });
  return { b: await s.browser(inv.link), personId: inv.personId };
}

beforeAll(async () => {
  s = await startTestServer();
  await s.createDoc("thesis", { language: "es" });
  await s.createDoc("paper", { language: "en" });
  expect((await s.publish("thesis")).status).toBe(201);
  expect((await s.publish("paper")).status).toBe(201);
  A = await reviewer("thesis", "Dr. A", "a@example.test", "instant");
  B = await reviewer("thesis", "Dra. B", "b@example.test", "instant");
  C = await reviewer("thesis", "Dr. C", "c@example.test", "daily");
  // A also reviews the paper (in English).
  await s.invite("paper", { person_id: A.personId, role: "Reviewer" });
});
afterAll(async () => {
  await s.stop();
});

describe("reply notifications to reviewers", () => {
  it("email the participants who chose «at once», never the author of the reply, never the secret link", async () => {
    t1 = ((await (await A.b.send("POST", "/api/documents/thesis/threads", point(1, "¿Está bien este párrafo?"))).json()) as { thread: { id: number } }).thread.id;
    await settle();
    let from = s.mails.length;
    expect(mailsTo("a@example.test", 0)).toEqual([]);

    expect((await B.b.send("POST", `/api/threads/${t1}/comments`, { body: "Yo lo dejaría así." })).status).toBe(201);
    await settle();
    const a = mailsTo("a@example.test", from);
    expect(a).toHaveLength(1);
    expect(a[0]!.subject).toContain("Respuesta de Dra. B");
    expect(a[0]!.subject).toMatch(/^\[Document thesis\]/);
    expect(a[0]!.text).toContain("Yo lo dejaría así.");
    expect(a[0]!.text).toContain(`${ORIGIN}/d/thesis/v/1#thread-${t1}`);
    expect(a[0]!.text).toContain("use su enlace personal");
    expect(a[0]!.text).not.toContain("/a/");
    expect(mailsTo("b@example.test", from)).toEqual([]);
    expect(mailsTo("c@example.test", from)).toEqual([]); // not a participant

    from = s.mails.length;
    expect((await s.ownerJson("POST", `/api/threads/${t1}/comments`, { body: "Gracias a ambos." })).status).toBe(201);
    await settle();
    expect(mailsTo("a@example.test", from)).toHaveLength(1);
    expect(mailsTo("b@example.test", from)).toHaveLength(1);
    expect(mailsTo("c@example.test", from)).toEqual([]);
  });

  it("are in each document's language", async () => {
    const t = ((await (await A.b.send("POST", "/api/documents/paper/threads", point(2, "Is this right?"))).json()) as { thread: { id: number } }).thread.id;
    await settle();
    expect(s.telegrams.at(-1)).toContain("New comment from Dr. A (Reviewer)");
    const from = s.mails.length;
    await s.ownerJson("POST", `/api/threads/${t}/comments`, { body: "Yes." });
    await settle();
    const [m] = mailsTo("a@example.test", from);
    expect(m!.subject).toBe("[Document paper] Reply from Eduardo Ejemplo");
    expect(m!.text).toContain("Dear Dr. A,");
    expect(m!.text).toContain(`${ORIGIN}/notifications`);
  });

  it("respect the document's visibility: no email about a comment the reviewer can't see", async () => {
    await s.ownerJson("PATCH", "/api/documents/thesis", { visibility: "own" });
    try {
      let from = s.mails.length;
      expect((await B.b.send("POST", `/api/threads/${t1}/comments`, { body: "Comentario de B en modo privado" })).status).toBe(404);
      expect((await s.ownerJson("POST", `/api/threads/${t1}/comments`, { body: "Respuesta del autor" })).status).toBe(201);
      await settle();
      expect(mailsTo("a@example.test", from)).toHaveLength(1);
      expect(mailsTo("b@example.test", from)).toEqual([]);
      const t = ((await (await s.ownerJson("POST", "/api/documents/thesis/threads", point(2, "¿Qué opinan?"))).json()) as { thread: { id: number } }).thread.id;
      await A.b.send("POST", `/api/threads/${t}/comments`, { body: "Opina A" });
      await settle();
      from = s.mails.length;
      await B.b.send("POST", `/api/threads/${t}/comments`, { body: "Opina B" });
      await settle();
      expect(mailsTo("a@example.test", from)).toEqual([]);
      expect(s.mails.slice(from).some((m) => m.text.includes("Opina B") && m.to !== "owner@example.test")).toBe(false);
    } finally {
      await s.ownerJson("PATCH", "/api/documents/thesis", { visibility: "all" });
    }
  });

  it("«Never» means no email", async () => {
    await s.ownerJson("PATCH", `/api/people/${B.personId}`, { notify_replies: "never" });
    const from = s.mails.length;
    await A.b.send("POST", `/api/threads/${t1}/comments`, { body: "Una más" });
    await settle();
    expect(mailsTo("b@example.test", from)).toEqual([]);
    expect((await s.ownerJson("PATCH", `/api/people/${B.personId}`, { notify_replies: "a veces" })).status).toBe(400);
  });
});

describe("the reviewers' Notifications page", () => {
  it("lets a reviewer choose for themselves (CSRF-protected form)", async () => {
    let res = await C.b.get("/notifications", { "accept-language": "es" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("c@example.test");
    expect(text).toMatch(/value="daily" checked/);
    expect(text).toContain("Cuando alguien responda");
    const post = (csrf: string, replies: string, versions?: string) =>
      fetch(s.url + "/notifications", {
        method: "POST",
        redirect: "manual",
        headers: { cookie: C.b.cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: csrf, replies, ...(versions ? { versions } : {}) }).toString(),
      });
    expect((await post("wrong", "instant")).status).toBe(403);
    expect((await post(C.b.csrf, "sometimes")).status).toBe(400);
    res = await post(C.b.csrf, "instant", "1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/notifications?saved=1");
    expect((await C.b.json<{ notifications: unknown }>("/api/me")).notifications).toEqual({ replies: "instant", versions: true, email: true });
    await post(C.b.csrf, "daily");
    expect(await (await C.b.get("/d/thesis/v/1")).text()).toContain('href="/notifications"');
    expect((await s.owner("/notifications", { redirect: "manual" })).status).toBe(303);
    // A lists the documents the settings apply to.
    expect(await (await A.b.get("/notifications", { "accept-language": "en" })).text()).toContain("These settings apply to all your documents");
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
    new Notifier({ publicUrl: ORIGIN, telegram, mailer, ownerEmail: "", instant: false, log: () => undefined });

  it("a reviewer's daily digest: replies by others in their threads, once a day per document, retried after a failure", async () => {
    const t = ((await (await C.b.send("POST", "/api/documents/thesis/threads", point(3, "Revise la figura 2"))).json()) as { thread: { id: number } }).thread.id;
    await s.ownerJson("POST", `/api/threads/${t}/comments`, { body: "Ya la cambié" });
    await A.b.send("POST", `/api/threads/${t}/comments`, { body: "Se ve mejor" });
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
    expect(await runReviewerDigests(config, s.repo, n, at(7))).toBe(0); // before 8:00
    expect(await runReviewerDigests(config, s.repo, n, at(9), (m) => void logs.push(m))).toBe(0);
    expect(logs[0]).toMatch(/reviewer digest failed for invitation #\d+: SMTP 451/);
    fail = false;
    expect(await runReviewerDigests(config, s.repo, n, new Date(at(9).getTime() + 300_000))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("c@example.test");
    expect(sent[0]!.subject).toContain("Resumen: 2 respuestas");
    expect(sent[0]!.text).toContain("Ya la cambié");
    expect(sent[0]!.text).toContain("Se ve mejor");
    expect(sent[0]!.text).not.toContain("Revise la figura 2"); // their own comment
    expect(sent[0]!.text).not.toContain("/a/");
    expect(await runReviewerDigests(config, s.repo, n, new Date(at(9).getTime() + 600_000))).toBe(0); // same day
  });

  it("the owner's digest of each document marks the day only after it went out", async () => {
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
    expect(await runDigest(config, s.repo, n, at(9))).toBe(0);
    const doc = (await s.repo.documentBySlug("thesis"))!;
    expect(await s.repo.digestDone(doc.id, new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(at(9)))).toBe(false);
    fail = false;
    expect(await runDigest(config, s.repo, n, new Date(at(9).getTime() + 300_000))).toBe(2);
    expect(tg.find((m) => m.includes("Resumen diario de «Document thesis»"))).toBeTruthy();
    expect(tg.find((m) => m.includes("Daily digest of «Document paper»"))).toBeTruthy();
    expect(await runDigest(config, s.repo, n, new Date(at(9).getTime() + 600_000))).toBe(0);
  });
});

describe("edits", () => {
  it("notify the owner when a reviewer edits a comment, and keep the previous texts", async () => {
    const r = (await (await A.b.send("POST", `/api/threads/${t1}/comments`, { body: "Primera redacción" })).json()) as { comment_id: number };
    await settle();
    const before = s.telegrams.length;
    expect((await A.b.send("PATCH", `/api/comments/${r.comment_id}`, { body: "Segunda redacción" })).status).toBe(200);
    expect((await A.b.send("PATCH", `/api/comments/${r.comment_id}`, { body: "Tercera redacción" })).status).toBe(200);
    await settle();
    const msgs = s.telegrams.slice(before);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("Dr. A editó un comentario");
    expect(msgs[0]).toMatch(/Antes:\nPrimera redacción\n\nAhora:\nSegunda redacción/);
    const edits = (await (await s.owner(`/api/comments/${r.comment_id}/edits`)).json()) as { edits: { body: string }[] };
    expect(edits.edits.map((e) => e.body)).toEqual(["Segunda redacción", "Primera redacción"]);
    expect((await A.b.get(`/api/comments/${r.comment_id}/edits`)).status).toBe(403);
    const o = (await (await s.ownerJson("POST", `/api/threads/${t1}/comments`, { body: "x" })).json()) as { comment_id: number };
    await settle();
    const n = s.telegrams.length;
    await s.ownerJson("PATCH", `/api/comments/${o.comment_id}`, { body: "y" });
    await settle();
    expect(s.telegrams.length).toBe(n);
  });
});

describe("sessions", () => {
  it("the cookie's Max-Age is extended with the server-side session", async () => {
    let res = await fetch(s.url + "/api/me", { headers: { cookie: A.b.cookie } });
    expect(res.headers.getSetCookie()).toEqual([]);
    await s.repo.db.query("update sessions set last_seen_at = now() - interval '2 hours' where person_id = $1", [A.personId]);
    res = await fetch(s.url + "/api/me", { headers: { cookie: A.b.cookie } });
    const set = res.headers.getSetCookie()[0]!;
    expect(set.split(";")[0]).toBe(A.b.cookie);
    expect(set).toMatch(new RegExp(`Max-Age=${180 * 24 * 3600}; Secure; SameSite=Lax; HttpOnly`));
  });
});
