// The owner's pages: the dashboard (documents, people, sessions) and a
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
people?.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-action=edit-person]");
  if (!b) return;
  const name = prompt(t("js.person_name"), b.dataset.name ?? "");
  if (name === null) return;
  const email = prompt(t("js.person_email", { name }), b.dataset.email ?? "");
  if (email === null) return;
  try {
    await api("PATCH", `/api/people/${b.dataset.id}`, { name, email: email.trim() });
    location.reload();
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

document.querySelector("table.invitations")?.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const { id, name } = b.dataset;
  try {
    if (b.dataset.action === "rotate") {
      if (!confirm(t("js.rotate_confirm", { name }))) return;
      const send = confirm(t("js.rotate_send"));
      const r = await api("POST", `/api/invitations/${id}/rotate`, { send_link: send });
      showLink(r.invitation.person.name, r.link, send ? r.email : null);
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
