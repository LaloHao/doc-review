// Reviewers (owner only): people, and their invitations to documents (role
// label, secret link, rotation and revocation); a person's page, delete and archive.

import { translator } from "../../i18n/index.js";
import type { Document, Invitation, Person } from "../../repo.js";
import type { App, Ctx } from "../context.js";
import { html, HttpError, json, readJson } from "../http.js";
import { personPage } from "../pages/owner.js";
import type { Router } from "../router.js";
import { emailField, intField, line, replyNotify, toInt } from "../validate.js";

export const personJson = (p: Person) => ({
  id: p.id,
  name: p.name,
  email: p.email,
  notify_versions: p.notify_versions,
  notify_replies: p.notify_replies,
  created_at: new Date(p.created_at).toISOString(),
  last_seen_at: p.last_seen_at ? new Date(p.last_seen_at).toISOString() : null,
  archived: p.archived_at !== null,
});

/** An invitation's state: active (opened or not yet) or revoked. */
export const invitationState = (i: Invitation): "active" | "unused" | "revoked" =>
  i.revoked_at ? "revoked" : i.last_seen_at ? "active" : "unused";

const invitationJson = (i: Invitation, extra: { person?: Person; document?: Document } = {}) => ({
  id: i.id,
  role: i.role,
  active: i.revoked_at === null,
  state: invitationState(i),
  created_at: new Date(i.created_at).toISOString(),
  rotated_at: i.rotated_at ? new Date(i.rotated_at).toISOString() : null,
  revoked_at: i.revoked_at ? new Date(i.revoked_at).toISOString() : null,
  last_seen_at: i.last_seen_at ? new Date(i.last_seen_at).toISOString() : null,
  ...(extra.person ? { person: personJson(extra.person) } : {}),
  ...(extra.document ? { document: extra.document.slug } : {}),
});

export function reviewerRoutes(r: Router<Ctx>, app: App): void {
  const { repo, notifier, log } = app;

  /**
   * Sending a link by email was asked for: it must be possible before anything
   * changes (a rotation would otherwise end the old link for nothing).
   */
  const canSendLink = (p: Person) => {
    if (!notifier.enabled.reviewerEmail) throw new HttpError(409, "err.email_off");
    if (!p.email) throw new HttpError(409, "err.no_email_address", { name: p.name });
  };
  const notArchived = (p: Person) => {
    if (p.archived_at) throw new HttpError(409, "err.person_archived", { name: p.name });
  };

  const maybeSendLink = async (doc: Document, p: Person, secret: string, wanted: boolean) => {
    if (!wanted) return { sent: false };
    try {
      await notifier.sendLink(doc, p, app.linkOf(secret));
      log(`link emailed to person #${p.id} (document #${doc.id})`);
      return { sent: true };
    } catch (e) {
      return { sent: false, error: (e as Error).message };
    }
  };

  const personPatch = (b: Record<string, unknown>) => {
    const patch: Parameters<typeof repo.updatePerson>[1] = {};
    if ("name" in b) patch.name = line(b.name, "field.name", 200, { required: true });
    if ("email" in b) patch.email = emailField(b.email);
    if ("notify_versions" in b) patch.notify_versions = b.notify_versions === true;
    if ("notify_replies" in b) patch.notify_replies = replyNotify(b.notify_replies);
    return patch;
  };

  // --- people ---

  r.get("/people/:id", async (c) => {
    app.requireOwner(c);
    const p = await repo.getPerson(toInt(c.params[0]));
    if (!p) throw new HttpError(404, "err.no_person");
    const tr = translator(c.lang);
    html(
      c.res,
      200,
      personPage(app.layout(c, tr, tr("person.page_title", { name: p.name })), {
        person: p,
        invitations: await repo.invitationsOfPerson(p.id),
        comments: await repo.personComments(p.id),
        emailOn: notifier.enabled.reviewerEmail,
      }),
    );
  });

  r.get("/api/people", async (c) => {
    app.requireOwner(c);
    const all = await repo.allInvitations();
    const archived = ["1", "true"].includes(c.url.searchParams.get("archived") ?? "");
    json(c.res, 200, {
      people: (await repo.listPeople({ archived })).map((p) => ({
        ...personJson(p),
        invitations: all.filter((i) => i.person_id === p.id).map((i) => invitationJson(i, { document: i.document })),
      })),
    });
  });

  r.post("/api/people", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const b = await readJson(c.req);
    const p = await repo.createPerson({
      name: line(b.name, "field.name", 200, { required: true }),
      email: emailField(b.email),
      notify_versions: b.notify_versions === true,
      notify_replies: b.notify_replies === undefined ? "never" : replyNotify(b.notify_replies),
    });
    log(`person #${p.id} created`);
    json(c.res, 201, { person: personJson(p) });
  });

  r.patch("/api/people/:id", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const id = toInt(c.params[0]);
    const p = await repo.updatePerson(id, personPatch(await readJson(c.req)));
    if (!p) throw new HttpError(404, "err.no_person");
    json(c.res, 200, { person: personJson(p) });
  });

  r.get("/api/people/:id", async (c) => {
    app.requireOwner(c);
    const p = await repo.getPerson(toInt(c.params[0]));
    if (!p) throw new HttpError(404, "err.no_person");
    json(c.res, 200, {
      person: {
        ...personJson(p),
        comments: await repo.personComments(p.id),
        invitations: (await repo.invitationsOfPerson(p.id)).map((i) => invitationJson(i, { document: i.document })),
      },
    });
  });

  // Deletes a person who never commented; 409 otherwise (archive them instead).
  r.delete("/api/people/:id", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const id = toInt(c.params[0]);
    const res = await repo.deletePerson(id);
    if (res === "not_found") throw new HttpError(404, "err.no_person");
    if (res === "has_comments") throw new HttpError(409, "err.person_has_comments");
    log(`person #${id} deleted`);
    json(c.res, 200, { deleted: true });
  });

  for (const [action, archived] of [["archive", true], ["unarchive", false]] as const) {
    r.post(`/api/people/:id/${action}`, async (c) => {
      app.requireOwner(c);
      app.checkCsrf(c);
      const id = toInt(c.params[0]);
      const p = await repo.setPersonArchived(id, archived);
      if (!p) throw new HttpError(404, "err.no_person");
      log(`person #${id} ${archived ? "archived" : "unarchived"}`);
      json(c.res, 200, { person: personJson(p) });
    });
  }

  // --- invitations ---

  r.get("/api/documents/:slug/invitations", async (c) => {
    app.requireOwner(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    json(c.res, 200, { invitations: (await repo.invitationsOfDocument(doc.id)).map((i) => invitationJson(i, { person: i.person })) });
  });

  // Invite an existing person ({person_id}) or a new one ({name, email}).
  r.post("/api/documents/:slug/invitations", async (c) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const { doc } = await app.documentFor(c, c.params[0]);
    app.requireWritable(doc);
    const b = await readJson(c.req);
    const role = "role" in b ? line(b.role, "field.role", 100) : doc.default_role;
    const sendLink = b.send_link === true;
    if (sendLink && !notifier.enabled.reviewerEmail) throw new HttpError(409, "err.email_off");
    let person: Person | null;
    if (b.person_id !== undefined && b.person_id !== null && b.person_id !== "") {
      person = await repo.getPerson(typeof b.person_id === "number" ? intField(b.person_id, "field.id") : toInt(String(b.person_id)));
      if (!person) throw new HttpError(404, "err.no_person");
      notArchived(person);
    } else {
      const name = line(b.name, "field.name", 200, { required: true });
      const email = emailField(b.email);
      if (sendLink && !email) throw new HttpError(409, "err.no_email_address", { name });
      person = await repo.createPerson({ name, email });
      log(`person #${person.id} created`);
    }
    if (sendLink) canSendLink(person);
    const created = await repo.createInvitation(doc.id, person.id, role);
    if (!created) throw new HttpError(409, "err.already_invited");
    log(`invitation #${created.invitation.id} created (document #${doc.id}, person #${person.id})`);
    const mail = await maybeSendLink(doc, person, created.secret, sendLink);
    json(c.res, 201, { invitation: invitationJson(created.invitation, { person, document: doc }), link: app.linkOf(created.secret), email: mail });
  });

  const invitationOr404 = async (c: Ctx) => {
    app.requireOwner(c);
    app.checkCsrf(c);
    const i = await repo.getInvitation(toInt(c.params[0]));
    if (!i) throw new HttpError(404, "err.no_invitation");
    return { invitation: i, doc: (await repo.getDocument(i.document_id))!, person: (await repo.getPerson(i.person_id))! };
  };

  r.patch("/api/invitations/:id", async (c) => {
    const { invitation, doc, person } = await invitationOr404(c);
    const b = await readJson(c.req);
    const i = "role" in b ? await repo.setInvitationRole(invitation.id, line(b.role, "field.role", 100)) : invitation;
    json(c.res, 200, { invitation: invitationJson(i!, { person, document: doc }) });
  });

  r.post("/api/invitations/:id/rotate", async (c) => {
    const { invitation, doc, person } = await invitationOr404(c);
    const b = c.req.headers["content-type"]?.startsWith("application/json") ? await readJson(c.req) : {};
    const sendLink = b.send_link === true;
    notArchived(person);
    if (sendLink) canSendLink(person);
    const res = await repo.rotateInvitation(invitation.id);
    log(`invitation #${invitation.id} link rotated`);
    const mail = await maybeSendLink(doc, person, res!.secret, sendLink);
    json(c.res, 200, { invitation: invitationJson(res!.invitation, { person, document: doc }), link: app.linkOf(res!.secret), email: mail });
  });

  r.post("/api/invitations/:id/revoke", async (c) => {
    const { invitation, doc, person } = await invitationOr404(c);
    const i = await repo.revokeInvitation(invitation.id);
    log(`invitation #${invitation.id} revoked`);
    json(c.res, 200, { invitation: invitationJson(i!, { person, document: doc }) });
  });
}
