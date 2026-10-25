// Owner dashboard: publish a version, manage director links, settings.

import { api, el } from "/static/common.js";

const linkBox = document.getElementById("link-result");

function showLink(name, link, email) {
  const input = el("input", { type: "text", readonly: true, value: link, class: "link-input", "aria-label": "Enlace" });
  const copy = el("button", {
    type: "button",
    text: "Copiar",
    onclick: async () => {
      input.select();
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = "Copiado";
      } catch {
        document.execCommand("copy");
      }
    },
  });
  linkBox.replaceChildren(
    el("p", {}, el("strong", { text: `Enlace de ${name}` }), " — se muestra solo esta vez. Envíalo por un canal privado."),
    el("div", { class: "row" }, input, copy),
    email?.sent ? el("p", { class: "plus", text: "También se envió por correo." }) : null,
    email && !email.sent && email.error ? el("p", { class: "error", text: `No se envió por correo: ${email.error}` }) : null,
    el("p", {}, el("a", { href: "/", text: "Actualizar la lista" })),
  );
  linkBox.hidden = false;
  linkBox.scrollIntoView({ block: "nearest" });
}

document.getElementById("director-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const wanted = f.elements.send_link.checked;
  try {
    const r = await api("POST", "/api/directors", {
      name: f.elements.name.value,
      role: f.elements.role.value,
      email: f.elements.email.value,
      notify_versions: f.elements.notify_versions.checked,
      send_link: wanted,
    });
    f.reset();
    showLink(r.director.name, r.link, wanted ? r.email : null);
  } catch (err) {
    alert(err.message);
  }
});

document.querySelector("table.directors")?.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const id = b.dataset.id;
  const name = b.dataset.name;
  try {
    if (b.dataset.action === "rotate") {
      if (!confirm(`¿Generar un enlace nuevo para ${name}? El enlace anterior dejará de funcionar.`)) return;
      const send = confirm("¿Enviar el enlace nuevo por correo? (Aceptar = enviar enlace por correo; Cancelar = solo mostrarlo aquí)");
      const r = await api("POST", `/api/directors/${id}/rotate`, { send_link: send });
      showLink(r.director.name, r.link, send ? r.email : null);
    } else if (b.dataset.action === "revoke") {
      if (!confirm(`¿Revocar el acceso de ${name}? Su enlace y sus sesiones dejan de funcionar.`)) return;
      await api("POST", `/api/directors/${id}/revoke`, {});
      location.reload();
    } else if (b.dataset.action === "edit") {
      const email = prompt(`Correo de ${name} (vacío para quitarlo):`, b.dataset.email ?? "");
      if (email === null) return;
      const notify = email.trim() !== "" && confirm("¿Avisarle por correo cuando publiques una versión nueva?");
      await api("PATCH", `/api/directors/${id}`, { email: email.trim(), notify_versions: notify });
      location.reload();
    }
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("settings-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = document.getElementById("settings-status");
  try {
    await api("PUT", "/api/settings", { comments_visibility: e.target.elements.visibility.value });
    status.textContent = "Guardado.";
  } catch (err) {
    status.textContent = err.message;
  }
});

document.getElementById("upload-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const status = document.getElementById("upload-status");
  const max = Number(document.body.dataset.maxPdfMb) * 1024 * 1024;
  const pdf = f.elements.pdf.files[0];
  if (pdf && pdf.size > max) {
    status.textContent = "El PDF es demasiado grande.";
    return;
  }
  const data = new FormData();
  data.set("pdf", pdf);
  data.set("avance", f.elements.avance.files[0]);
  data.set("note", f.elements.note.value);
  status.textContent = "Publicando…";
  try {
    const r = await api("POST", "/api/versions", data);
    status.textContent = `Versión ${r.version.number} publicada.`;
    location.href = `/v/${r.version.number}`;
  } catch (err) {
    status.textContent = err.message;
  }
});
