#!/usr/bin/env node
// doc-review: server and owner CLI.

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { progressFromOrg } from "./progress.js";
import { Client, loadClientConfig } from "./client.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db/db.js";
import { newOwnerToken, sha256Hex } from "./server/crypto.js";
import { fmtThread, oneLine } from "./format.js";
import { startServer } from "./server/main.js";

const HELP = `doc-review — comentarios de los directores sobre el PDF de la tesis

Servidor:
  doc-review serve                 inicia el servidor (configuración por variables de entorno)
  doc-review migrate               aplica las migraciones (DATABASE_ADMIN_URL o DATABASE_URL)
  doc-review gen-token             genera un token de autor y su SHA-256 (OWNER_TOKEN_SHA256)

Autor (usa ~/.config/doc-review/config.json: {"url", "token"}, modo 0600):
  doc-review publish tesis.pdf avance.json [-m "nota"]
  doc-review comments [--version N|latest] [--all] [--json]
  doc-review avance tesis.org [-o avance.json]   genera avance.json desde los #+INCLUDE
  doc-review directors list
  doc-review directors add "Nombre" [--role R] [--email E] [--notify] [--replies instant|daily|never] [--send-link]
  doc-review directors replies ID instant|daily|never   avisos de respuestas por correo
  doc-review directors rotate ID [--send-link]
  doc-review directors revoke ID
  doc-review sessions close-all [--directors]    cierra tus sesiones web (y las de los directores)
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;

    case "serve": {
      const running = await startServer(loadConfig());
      const stop = async () => {
        await running.close();
        process.exit(0);
      };
      process.on("SIGTERM", () => void stop());
      process.on("SIGINT", () => void stop());
      return -1; // keep running
    }

    case "migrate": {
      const c = loadConfig();
      const db = await openDb(c.databaseAdminUrl);
      const applied = await migrate(db);
      await db.close();
      console.log(applied.length ? `aplicadas: ${applied.join(", ")}` : "sin migraciones pendientes");
      return 0;
    }

    case "gen-token": {
      const token = newOwnerToken();
      console.log(`token (en ~/.config/doc-review/config.json):\n  ${token}`);
      console.log(`OWNER_TOKEN_SHA256 (en el Secret del servidor):\n  ${sha256Hex(token)}`);
      return 0;
    }

    case "publish": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { message: { type: "string", short: "m" } } });
      const [pdf, progress] = positionals;
      if (!pdf) throw new Error("uso: doc-review publish documento.pdf [progress.json] [-m nota]");
      const client = new Client(await loadClientConfig());
      const r = await client.publish(pdf, progress ?? null, values.message ?? "");
      console.log(`publicada la versión ${r.version.number} (${r.version.page_count} páginas): ${r.url}`);
      return 0;
    }

    case "comments": {
      const { values } = parseArgs({
        args: rest,
        options: { version: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
      });
      const client = new Client(await loadClientConfig());
      const { threads } = await client.threads({ version: values.version, status: values.all ? "all" : "open" });
      if (values.json) console.log(JSON.stringify(threads, null, 2));
      else if (threads.length === 0) console.log("sin comentarios abiertos");
      else console.log(threads.map(fmtThread).join("\n\n"));
      return 0;
    }

    case "progress": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { output: { type: "string", short: "o" } } });
      const root = positionals[0] ?? "tesis.org";
      const a = await progressFromOrg(root);
      const out = JSON.stringify(a, null, 2) + "\n";
      if (values.output) await writeFile(values.output, out);
      else process.stdout.write(out);
      return 0;
    }

    case "directors": {
      const [sub, ...args] = rest;
      const client = new Client(await loadClientConfig());
      type D = { id: number; name: string; role: string; email: string | null; active: boolean; notify_replies: string };
      if (sub === "list" || sub === undefined) {
        const { directors } = await client.request<{ directors: D[] }>("GET", "/api/directors");
        for (const d of directors) console.log([d.id, d.active ? "activo" : "revocado", d.name, d.role, d.email ?? "", `respuestas: ${d.notify_replies}`].map((x) => oneLine(String(x))).join("\t"));
        return 0;
      }
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          role: { type: "string" },
          email: { type: "string" },
          notify: { type: "boolean" },
          replies: { type: "string" },
          "send-link": { type: "boolean" },
        },
      });
      if (sub === "add") {
        const name = positionals[0];
        if (!name) throw new Error('uso: doc-review directors add "Nombre" [--role R] [--email E]');
        const r = await client.json<{ director: D; link: string; email: { sent: boolean; error?: string } }>("POST", "/api/directors", {
          name,
          role: values.role ?? "",
          email: values.email ?? "",
          notify_versions: values.notify === true,
          notify_replies: values.replies ?? "never",
          send_link: values["send-link"] === true,
        });
        console.log(`director ${r.director.id}: ${r.director.name}\nenlace (se muestra una sola vez): ${r.link}`);
        if (values["send-link"]) console.log(r.email.sent ? "enlace enviado por correo" : `no se envió el correo: ${r.email.error}`);
        return 0;
      }
      const id = Number(positionals[0]);
      if (!Number.isInteger(id)) throw new Error(`uso: doc-review directors ${sub} ID`);
      if (sub === "rotate") {
        const r = await client.json<{ director: D; link: string; email: { sent: boolean; error?: string } }>("POST", `/api/directors/${id}/rotate`, {
          send_link: values["send-link"] === true,
        });
        console.log(`enlace nuevo de ${r.director.name} (el anterior ya no funciona): ${r.link}`);
        if (values["send-link"]) console.log(r.email.sent ? "enlace enviado por correo" : `no se envió el correo: ${r.email.error}`);
        return 0;
      }
      if (sub === "replies") {
        const r = await client.json<{ director: D }>("PATCH", `/api/directors/${id}`, { notify_replies: positionals[1] });
        console.log(`avisos de respuestas de ${oneLine(r.director.name)}: ${r.director.notify_replies}`);
        return 0;
      }
      if (sub === "revoke") {
        const r = await client.json<{ director: D }>("POST", `/api/directors/${id}/revoke`, {});
        console.log(`revocado: ${r.director.name}`);
        return 0;
      }
      throw new Error(`subcomando desconocido: directors ${sub}`);
    }

    case "sessions": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { directors: { type: "boolean" } } });
      if (positionals[0] !== "close-all") throw new Error("uso: doc-review sessions close-all [--directors]");
      const client = new Client(await loadClientConfig());
      const r = await client.json<{ closed: { owner: number; directors: number } }>("POST", "/api/sessions/close-all", {
        directors: values.directors === true,
      });
      console.log(`sesiones cerradas: ${r.closed.owner} tuyas, ${r.closed.directors} de directores`);
      return 0;
    }

    default:
      process.stderr.write(`comando desconocido: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  },
);
