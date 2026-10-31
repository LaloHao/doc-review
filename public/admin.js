// The owner's pages: the dashboard (documents, people, sessions), a person's page and a
// document's management page (publish, invitations, settings, archive).

import { api, el, t } from "/static/common.js";

const DOC = document.body.dataset.document ?? "";
const DOC_API = `/api/documents/${encodeURIComponent(DOC)}`;
const linkBox = document.getElementById("link-result");

const fail = (err) => alert(err.message);

function showLink(name, link, email) {
  const input = el("input", { type: "text", readonly: true, value: link, class: "link-input", "aria-label": t("js.link") });
  const copy = el("button", {
    type: "button",
    text: t("js.copy"),
    onclick: async () => {
      input.select();
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = t("js.copied");
      } catch {
        document.execCommand("copy");
      }
    },
  });
  linkBox.replaceChildren(
    el("p", {}, el("strong", { text: t("js.link_of", { name }) }), " — ", t("js.link_once")),
    el("div", { class: "row" }, input, copy),
    email?.sent ? el("p", { class: "plus", text: t("js.link_emailed") }) : null,
    email && !email.sent && email.error ? el("p", { class: "error", text: t("js.link_not_emailed", { error: email.error }) }) : null,
    el("p", {}, el("a", { href: location.pathname, text: t("js.refresh_list") })),
  );
  linkBox.hidden = false;
  linkBox.scrollIntoView({ block: "nearest" });
}

// --- dashboard ---

document.getElementById("document-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api("POST", "/api/documents", {
      slug: f.elements.slug.value.trim(),
      title: f.elements.title.value,
      language: f.elements.language.value,
      visibility: f.elements.visibility.value,
      default_role: f.elements.default_role.value,
    });
    location.href = `/d/${encodeURIComponent(r.document.slug)}/manage`;
  } catch (err) {
    fail(err);
  }
});

// Suggest a slug from the title.
const docForm = document.getElementById("document-form");
docForm?.elements.title.addEventListener("input", () => {
  const slug = docForm.elements.slug;
  if (slug.dataset.touched) return;
  slug.value = docForm.elements.title.value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
});
docForm?.elements.slug.addEventListener("input", (e) => {
  e.target.dataset.touched = "1";
});

document.getElementById("person-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("POST", "/api/people", { name: f.elements.name.value, email: f.elements.email.value });
    location.reload();
  } catch (err) {
    fail(err);
  }
});

const people = document.querySelector("table.people");
people?.addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-action]");
  if (!sel) return;
  try {
    if (sel.dataset.action === "notify-replies") await api("PATCH", `/api/people/${sel.dataset.id}`, { notify_replies: sel.value });
    if (sel.dataset.action === "notify-versions") await api("PATCH", `/api/people/${sel.dataset.id}`, { notify_versions: sel.checked });
  } catch (err) {
    fail(err);
  }
});
document.getElementById("sessions-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const reviewers = e.target.elements.reviewers.checked;
  if (!confirm(t(reviewers ? "js.close_all_reviewers_confirm" : "js.close_all_confirm"))) return;
  try {
    await api("POST", "/api/sessions/close-all", { reviewers });
    location.href = "/login";
  } catch (err) {
    fail(err);
  }
});

// --- a document's page ---

document.getElementById("upload-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = document.getElementById("upload-status");
  const max = Number(document.body.dataset.maxPdfMb) * 1024 * 1024;
  const pdf = f.elements.pdf.files[0];
  if (pdf && pdf.size > max) {
    status.textContent = t("js.pdf_too_large");
    return;
  }
  const data = new FormData();
  data.set("pdf", pdf);
  const progress = f.elements.progress.files[0];
  if (progress) data.set("progress", progress);
  data.set("note", f.elements.note.value);
  status.textContent = t("js.publishing");
  try {
    const r = await api("POST", `${DOC_API}/versions`, data);
    status.textContent = t("js.published", { n: r.version.number });
    location.href = `/d/${encodeURIComponent(DOC)}/v/${r.version.number}`;
  } catch (err) {
    status.textContent = err.message;
  }
});

const invite = document.getElementById("invite-form");
const newPerson = invite?.querySelector(".new-person");
const toggleNewPerson = () => {
  if (newPerson) newPerson.hidden = Boolean(invite.elements.person_id?.value);
};
invite?.elements.person_id?.addEventListener("change", toggleNewPerson);
toggleNewPerson();

invite?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const wanted = f.elements.send_link.checked;
  const existing = f.elements.person_id?.value;
  try {
    const r = await api("POST", `${DOC_API}/invitations`, {
      ...(existing ? { person_id: Number(existing) } : { name: f.elements.name.value, email: f.elements.email.value }),
      role: f.elements.role.value,
      send_link: wanted,
    });
    showLink(r.invitation.person.name, r.link, wanted ? r.email : null);
    f.reset();
  } catch (err) {
    fail(err);
  }
});

// Invitations: on a document's page and on a person's page.
document.querySelector("table.invitations")?.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const { id, name, email } = b.dataset;
  try {
    if (b.dataset.action === "rotate") {
      if (!confirm(t("js.rotate_confirm", { name }))) return;
      // Only someone with an address can get it by email, and only if you say so.
      const send = Boolean(email) && confirm(t("js.rotate_send"));
      const r = await api("POST", `/api/invitations/${id}/rotate`, { send_link: send });
      showLink(r.invitation.person.name, r.link, send ? r.email : null);
    } else if (b.dataset.action === "email-link") {
      if (!email || !confirm(t("js.email_link_confirm", { name, email }))) return;
      const r = await api("POST", `/api/invitations/${id}/rotate`, { send_link: true });
      showLink(r.invitation.person.name, r.link, r.email);
    } else if (b.dataset.action === "revoke") {
      if (!confirm(t("js.revoke_confirm", { name }))) return;
      await api("POST", `/api/invitations/${id}/revoke`, {});
      location.reload();
    } else if (b.dataset.action === "role") {
      const role = prompt(t("js.role_prompt", { name }), b.dataset.role ?? "");
      if (role === null) return;
      await api("PATCH", `/api/invitations/${id}`, { role });
      location.reload();
    }
  } catch (err) {
    fail(err);
  }
});

// --- a person's page ---

const PERSON = document.body.dataset.person ?? "";
const PERSON_NAME = document.body.dataset.personName ?? "";

document.getElementById("person-edit-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = document.getElementById("person-status");
  try {
    await api("PATCH", `/api/people/${PERSON}`, {
      name: f.elements.name.value,
      email: f.elements.email.value.trim(),
      notify_replies: f.elements.notify_replies.value,
      notify_versions: f.elements.notify_versions.checked,
    });
    location.reload();
  } catch (err) {
    status.textContent = err.message;
  }
});

document.getElementById("delete-person")?.addEventListener("click", async () => {
  if (!confirm(t("js.delete_person_confirm", { name: PERSON_NAME }))) return;
  try {
    await api("DELETE", `/api/people/${PERSON}`);
    location.href = "/";
  } catch (err) {
    fail(err);
  }
});

for (const [button, action] of [
  ["archive-person", "archive"],
  ["unarchive-person", "unarchive"],
]) {
  document.getElementById(button)?.addEventListener("click", async () => {
    if (action === "archive" && !confirm(t("js.archive_person_confirm", { name: PERSON_NAME }))) return;
    try {
      await api("POST", `/api/people/${PERSON}/${action}`, {});
      location.reload();
    } catch (err) {
      fail(err);
    }
  });
}

document.getElementById("doc-settings-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = document.getElementById("settings-status");
  try {
    const r = await api("PATCH", DOC_API, {
      title: f.elements.title.value,
      slug: f.elements.slug.value.trim(),
      language: f.elements.language.value,
      visibility: f.elements.visibility.value,
      default_role: f.elements.default_role.value,
    });
    if (r.document.slug !== DOC) location.href = `/d/${encodeURIComponent(r.document.slug)}/manage`;
    else status.textContent = t("js.saved");
  } catch (err) {
    status.textContent = err.message;
  }
});

document.getElementById("archive-button")?.addEventListener("click", async (e) => {
  const archived = e.target.dataset.archived === "1";
  if (!archived && !confirm(t("js.archive_confirm"))) return;
  try {
    await api("POST", `${DOC_API}/${archived ? "unarchive" : "archive"}`, {});
    location.reload();
  } catch (err) {
    fail(err);
  }
});

// --- devices ---

document.querySelector("table.devices")?.addEventListener("click", async (e) => {
  const b = e.target.closest('[data-action="revoke-device"]');
  if (!b) return;
  const self = b.dataset.current === "1";
  if (!confirm(t(self ? "js.revoke_device_self_confirm" : "js.revoke_device_confirm", { name: b.dataset.name }))) return;
  try {
    await api("POST", `/api/devices/${b.dataset.id}/revoke`, {});
    if (self) location.href = "/login";
    else location.reload();
  } catch (err) {
    fail(err);
  }
});

let countdown = null;
document.getElementById("enroll-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const box = document.getElementById("enroll-result");
  let r;
  try {
    r = await api("POST", "/api/devices/enroll-codes", { name: f.elements.name.value });
  } catch (err) {
    fail(err);
    return;
  }
  const expires = Date.parse(r.expires_at);
  const left = el("p", { class: "muted" });
  const code = el("p", { class: "enroll-code", text: r.code });
  const tick = () => {
    const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
    if (s === 0) {
      left.textContent = t("js.enroll_expired");
      code.classList.add("muted");
      clearInterval(countdown);
      return;
    }
    left.textContent = t("js.enroll_expires_in", { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` });
  };
  clearInterval(countdown);
  countdown = setInterval(tick, 1000);
  tick();
  box.replaceChildren(
    el("p", {}, el("strong", { text: t("js.enroll_code_for", { name: r.name }) }), " — ", t("js.enroll_once")),
    code,
    left,
    el("p", { text: t("js.enroll_emacs", { url: r.url }) }),
    el("pre", { text: r.commands.emacs }),
    el("p", { text: t("js.enroll_cli") }),
    el("pre", { text: r.commands.cli }),
    el("p", { text: t("js.enroll_curl") }),
    el("pre", { text: r.commands.curl }),
    el("p", {}, el("a", { href: location.pathname, text: t("js.refresh_list") })),
  );
  box.hidden = false;
  box.scrollIntoView({ block: "nearest" });
  f.reset();
});
