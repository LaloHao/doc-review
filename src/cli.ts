#!/usr/bin/env node
// revision-tesis: server and owner CLI.

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { avanceFromOrg } from "./avance.js";
import { Client, loadClientConfig } from "./client.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db/db.js";
import { newOwnerToken, sha256Hex } from "./server/crypto.js";
import { fmtThread, oneLine } from "./format.js";
import { startServer } from "./server/main.js";

const HELP = `revision-tesis — comentarios de los directores sobre el PDF de la tesis

Servidor:
  revision-tesis serve                 inicia el servidor (configuración por variables de entorno)
  revision-tesis migrate               aplica las migraciones (DATABASE_ADMIN_URL o DATABASE_URL)
  revision-tesis gen-token             genera un token de autor y su SHA-256 (OWNER_TOKEN_SHA256)

Autor (usa ~/.config/revision-tesis/config.json: {"url", "token"}, modo 0600):
  revision-tesis publish tesis.pdf avance.json [-m "nota"]
  revision-tesis comments [--version N|latest] [--all] [--json]
  revision-tesis avance tesis.org [-o avance.json]   genera avance.json desde los #+INCLUDE
  revision-tesis directors list
  revision-tesis directors add "Nombre" [--role R] [--email E] [--notify] [--send-link]
  revision-tesis directors rotate ID [--send-link]
  revision-tesis directors revoke ID
  revision-tesis sessions close-all [--directors]    cierra tus sesiones web (y las de los directores)
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
      console.log(`token (en ~/.config/revision-tesis/config.json):\n  ${token}`);
      console.log(`OWNER_TOKEN_SHA256 (en el Secret del servidor):\n  ${sha256Hex(token)}`);
      return 0;
    }

    case "publish": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { message: { type: "string", short: "m" } } });
      const [pdf, avance] = positionals;
      if (!pdf || !avance) throw new Error("uso: revision-tesis publish tesis.pdf avance.json [-m nota]");
      const client = new Client(await loadClientConfig());
      const r = await client.publish(pdf, avance, values.message ?? "");
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

    case "avance": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { output: { type: "string", short: "o" } } });
      const root = positionals[0] ?? "tesis.org";
      const a = await avanceFromOrg(root);
      const out = JSON.stringify(a, null, 2) + "\n";
      if (values.output) await writeFile(values.output, out);
      else process.stdout.write(out);
      return 0;
    }

    case "directors": {
      const [sub, ...args] = rest;
      const client = new Client(await loadClientConfig());
      type D = { id: number; name: string; role: string; email: string | null; active: boolean };
      if (sub === "list" || sub === undefined) {
        const { directors } = await client.request<{ directors: D[] }>("GET", "/api/directors");
        for (const d of directors) console.log([d.id, d.active ? "activo" : "revocado", d.name, d.role, d.email ?? ""].map((x) => oneLine(String(x))).join("\t"));
        return 0;
      }
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          role: { type: "string" },
          email: { type: "string" },
          notify: { type: "boolean" },
          "send-link": { type: "boolean" },
        },
      });
      if (sub === "add") {
        const name = positionals[0];
        if (!name) throw new Error('uso: revision-tesis directors add "Nombre" [--role R] [--email E]');
        const r = await client.json<{ director: D; link: string; email: { sent: boolean; error?: string } }>("POST", "/api/directors", {
          name,
          role: values.role ?? "",
          email: values.email ?? "",
          notify_versions: values.notify === true,
          send_link: values["send-link"] === true,
        });
        console.log(`director ${r.director.id}: ${r.director.name}\nenlace (se muestra una sola vez): ${r.link}`);
        if (values["send-link"]) console.log(r.email.sent ? "enlace enviado por correo" : `no se envió el correo: ${r.email.error}`);
        return 0;
      }
      const id = Number(positionals[0]);
      if (!Number.isInteger(id)) throw new Error(`uso: revision-tesis directors ${sub} ID`);
      if (sub === "rotate") {
        const r = await client.json<{ director: D; link: string; email: { sent: boolean; error?: string } }>("POST", `/api/directors/${id}/rotate`, {
          send_link: values["send-link"] === true,
        });
        console.log(`enlace nuevo de ${r.director.name} (el anterior ya no funciona): ${r.link}`);
        if (values["send-link"]) console.log(r.email.sent ? "enlace enviado por correo" : `no se envió el correo: ${r.email.error}`);
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
      if (positionals[0] !== "close-all") throw new Error("uso: revision-tesis sessions close-all [--directors]");
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
