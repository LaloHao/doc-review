// The privacy notice reviewers see when the server logs their personal data (LOG_IDENTITIES).

import { afterEach, describe, expect, it } from "vitest";
import { loadPrivacyConfig } from "../src/config.js";
import { startTestServer, type TestServer } from "./helpers.js";

const servers: TestServer[] = [];
const start = async (env: Record<string, string> = {}) => {
  const s = await startTestServer(env);
  servers.push(s);
  return s;
};
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

/** A reviewer's page (their document's viewer) and the owner's dashboard, as HTML. */
async function pages(s: TestServer) {
  await s.createDoc("thesis");
  expect((await s.publish("thesis")).status).toBe(201);
  const inv = await s.invite("thesis", { name: "Dr. Jane Roe", email: "jane@example.test" });
  const reviewer = await s.browser(inv.link);
  const viewer = await (await reviewer.get("/d/thesis/v/1")).text();
  const notifications = await (await reviewer.get("/notifications")).text();
  const owner = await s.browser();
  const dashboard = await (await owner.get("/")).text();
  return { viewer, notifications, dashboard, reviewer };
}

describe("privacy notice", () => {
  it("is off by default: no link, no footer, no /privacy", async () => {
    expect(loadPrivacyConfig({}, false, "")).toBeNull();
    const s = await start();
    const { viewer, notifications } = await pages(s);
    for (const html of [viewer, notifications]) expect(html).not.toContain('href="/privacy"');
    expect((await fetch(s.url + "/privacy")).status).toBe(404);
  });

  it("with LOG_IDENTITIES: a link for reviewers, a footer outside the viewer, and the notice with contact and retention", async () => {
    const s = await start({ LOG_IDENTITIES: "true", LOG_RETENTION_DAYS: "15", EMAIL_OWNER_TO: "owner@example.test" });
    const { viewer, notifications, dashboard, reviewer } = await pages(s);
    expect(viewer).toContain('href="/privacy"');
    expect(viewer).not.toContain('class="privacy-note"');
    expect(notifications).toContain('class="privacy-note"');
    // The owner wrote it: not shown to them.
    expect(dashboard).not.toContain('href="/privacy"');

    const res = await reviewer.get("/privacy", { "accept-language": "es-MX,es;q=0.9" });
    expect(res.status).toBe(200);
    const notice = await res.text();
    expect(notice).toContain("Aviso de privacidad");
    expect(notice).toContain("dirección IP");
    expect(notice).toContain("después de 15 días");
    expect(notice).toContain('href="mailto:owner@example.test"');
    expect(notice).toContain("derechos ARCO");
    // Without a session too (a reviewer who wants to read it first).
    expect((await fetch(s.url + "/privacy")).status).toBe(200);
  });

  it("PRIVACY_NOTICE overrides; PRIVACY_CONTACT replaces the owner's email; a bad retention is refused", () => {
    expect(loadPrivacyConfig({ PRIVACY_NOTICE: "false" }, true, "o@x")).toBeNull();
    expect(loadPrivacyConfig({ PRIVACY_NOTICE: "true" }, false, "o@x")).toEqual({ contact: "o@x", retentionDays: null });
    expect(loadPrivacyConfig({ PRIVACY_CONTACT: "privacy@x" }, true, "o@x")).toEqual({ contact: "privacy@x", retentionDays: null });
    expect(() => loadPrivacyConfig({ LOG_RETENTION_DAYS: "0" }, true, "")).toThrow();
  });
});
