// The home page: the landing page, the owner's dashboard, a director's start.

import type { App, Ctx } from "../context.js";
import { html, redirect } from "../http.js";
import * as pages from "../pages.js";
import type { Router } from "../router.js";
import { esc } from "../../text.js";

export function documentRoutes(r: Router<Ctx>, app: App): void {
  const { repo, config, notifier } = app;

  r.get("/", async (c) => {
    if (!c.session) return html(c.res, 200, pages.landingPage());
    if (c.session.kind === "director") {
      const latest = await repo.latestVersion();
      if (!latest) {
        return html(c.res, 200, pages.page(app.layout(c, "Revisión de tesis"), `<main class="narrow"><h1>Bienvenido(a), ${esc(app.whoName(c.session))}</h1><p>Aún no hay ninguna versión publicada. Recibirá un aviso cuando la haya.</p></main>`));
      }
      return redirect(c.res, `/v/${latest.number}`);
    }
    const versions = await repo.listVersions();
    const open = await repo.listThreads({ kind: "owner", directorId: null }, { status: "open" });
    const openByVersion = new Map<number, number>();
    for (const t of open) openByVersion.set(t.version, (openByVersion.get(t.version) ?? 0) + 1);
    html(
      c.res,
      200,
      pages.ownerDashboard(app.layout(c, "Tu tesis"), {
        versions,
        openByVersion,
        directors: await repo.listDirectors(),
        visibility: await repo.visibility(),
        channels: {
          ...notifier.enabled,
          digest: config.digestHour === null ? null : `todos los días a las ${config.digestHour}:00 (${config.timeZone})`,
        },
        publicUrl: config.publicUrl,
        maxPdfMb: Math.round(config.maxPdfBytes / 1024 / 1024),
      }),
    );
  });
}
