// Part of scripts/smoke.sh: what reviewers do in their browsers, through the
// same API the pages use (session cookie, Origin, CSRF token). Prints what it
// checks and exits non-zero on the first surprise.
//
//   BASE=… ANA_THESIS=… LUIS=… node scripts/smoke-reviewers.mjs comment|visibility-own|visibility-all

const { BASE, ANA_THESIS, LUIS } = process.env;
const step = process.argv[2];

function check(cond, what) {
  if (!cond) {
    console.error(`FAILED: ${what}`);
    process.exit(1);
  }
  console.log(`ok - ${what}`);
}

class Browser {
  cookie = "";
  csrf = "";
  async open(link) {
    const res = await fetch(BASE + new URL(link).pathname, { redirect: "manual", headers: this.cookie ? { cookie: this.cookie } : {} });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-dr_session="));
    if (set) this.cookie = set.split(";")[0];
    const me = await fetch(BASE + "/api/me", { headers: { cookie: this.cookie } });
    this.csrf = (await me.json()).csrf;
    return res;
  }
  get(path) {
    return fetch(BASE + path, { redirect: "manual", headers: { cookie: this.cookie, "accept-language": "en" } });
  }
  send(method, path, body) {
    return fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: { cookie: this.cookie, origin: BASE, "x-csrf-token": this.csrf, "content-type": "application/json", "accept-language": "en" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

const ana = new Browser();
const luis = new Browser();

if (step === "comment") {
  const r = await ana.open(ANA_THESIS);
  check(r.status === 303 && r.headers.get("location") === "/d/thesis", "the thesis link signs Ana in and lands on the thesis");
  const docs = (await (await ana.get("/api/documents")).json()).documents;
  check(docs.map((d) => `${d.slug}:${d.role}`).sort().join(",") === "report:Reviewer,thesis:Director(a)", "one session sees both of Ana's documents, a role in each");
  let res = await ana.send("POST", "/api/documents/thesis/threads", {
    version: 1,
    page: 3,
    anchor: "text",
    quote: "sin una revisión formal suficiente",
    rects: [{ x: 0.4, y: 0.21, w: 0.3, h: 0.02 }],
    body: "Sugiero respaldar esta afirmación con una fuente reciente.",
  });
  const thread = (await res.json()).thread;
  check(res.status === 201 && thread.section.id === "01-introduccion", `Ana comments on the thesis (thread ${thread.id}, section ${thread.section.id})`);
  res = await ana.send("POST", "/api/documents/thesis/threads", { version: 1, page: 3, anchor: "point", rects: [{ x: 0.5, y: 0.5, w: 0, h: 0 }], body: "x" });
  check(res.status === 201, "a point comment too");
  const noCsrf = await fetch(BASE + "/api/documents/thesis/threads", { method: "POST", headers: { cookie: ana.cookie, origin: BASE, "content-type": "application/json" }, body: "{}" });
  check(noCsrf.status === 403, "without the CSRF token → 403");
  res = await ana.send("POST", "/api/documents/report/threads", { version: 1, page: 3, anchor: "text", quote: "connection pool that was too small", rects: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.02 }], body: "Was the pool size reviewed when the batch job was added?" });
  check(res.status === 201, "Ana comments on the report");

  const h = await luis.open(LUIS);
  check(h.headers.get("location") === "/d/thesis", "Luis's link lands on the thesis");
  check((await luis.get("/d/report/v/1")).status === 404 && (await luis.get("/api/documents/report/threads")).status === 404, "Luis can't see the report (404)");
  res = await luis.send("POST", `/api/threads/${thread.id}/comments`, { body: "Coincido; quizá el reporte de DORA de 2025." });
  check(res.status === 201, "Luis replies in Ana's thread");
  res = await luis.send("POST", `/api/threads/${thread.id}/resolve`);
  check(res.status === 403, "Luis can't resolve Ana's thread (403)");
  res = await ana.send("POST", `/api/threads/${thread.id}/resolve`);
  check(res.status === 200 && (await res.json()).thread.resolved_by.startsWith("Dra. Ana"), "Ana resolves her thread");
  res = await luis.send("POST", `/api/threads/${thread.id}/reopen`);
  check(res.status === 200, "Luis reopens it");
  res = await luis.send("POST", "/api/documents/thesis/threads", { version: 1, page: 4, anchor: "point", rects: [{ x: 0.7, y: 0.3, w: 0, h: 0 }], body: "Aquí convendría una figura." });
  check(res.status === 201, "Luis opens his own thread");
  console.log(`THREAD=${thread.id}`);
}

if (step === "visibility-own") {
  await ana.open(ANA_THESIS);
  await luis.open(LUIS);
  const list = async (b) => (await (await b.get("/api/documents/thesis/threads?status=all")).json()).threads;
  const j = await list(ana);
  const h = await list(luis);
  check(!JSON.stringify(j).includes("Aquí convendría una figura"), "with «own», Ana doesn't see Luis's thread");
  check(!JSON.stringify(h).includes("Sugiero respaldar"), "…nor Luis Ana's");
  check((await (await ana.get("/api/documents/report/threads")).json()).threads.length === 1, "the report keeps its own setting");
}

if (step === "visibility-all") {
  await ana.open(ANA_THESIS);
  const threads = (await (await ana.get("/api/documents/thesis/threads?status=all")).json()).threads;
  check(JSON.stringify(threads).includes("Aquí convendría una figura"), "with «all», Ana sees Luis's thread again");
}
