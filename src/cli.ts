#!/usr/bin/env node
// doc-review: the server and the owner's command line.

import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { ApiError, Client, findProjectConfig, loadClientConfig, projectPdf, type ProjectConfig } from "./client.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db/db.js";
import { fmtThread, oneLine } from "./format.js";
import { progressFromOrg } from "./progress.js";
import { newOwnerToken, sha256Hex } from "./server/crypto.js";
import { startServer } from "./server/main.js";

const HELP = `doc-review — reviewers comment on PDF versions of your documents

Server:
  doc-review serve                     start the server (configured by environment variables)
  doc-review migrate                   apply database migrations (DATABASE_ADMIN_URL or DATABASE_URL)
  doc-review gen-token                 generate an owner token and its SHA-256 (OWNER_TOKEN_SHA256)

Owner commands use ~/.config/doc-review/config.json ({"url", "token"}, mode 0600).
DOC is -d SLUG, else DOC_REVIEW_DOCUMENT, else "document" in .doc-review.json
(found from the current directory upward). --url URL picks another server
(its token must be in config.json under "servers").

Documents:
  doc-review documents list
  doc-review documents create SLUG "Title" [--language en|es] [--visibility all|own] [--default-role ROLE]
  doc-review documents rename SLUG "New title" [--slug NEW-SLUG]
  doc-review documents set SLUG [--language en|es] [--visibility all|own] [--default-role ROLE]
  doc-review documents archive SLUG | unarchive SLUG

Versions and comments:
  doc-review publish [FILE.pdf] [PROGRESS.json] [-m NOTE] [-d DOC]
                                       without files: "pdf" and "progress" of .doc-review.json
                                       ("pdf" may be a list of files and globs: the newest match)
  doc-review comments [-d DOC] [--version N|latest] [--all] [--json]
  doc-review progress ROOT.org [-o progress.json]   progress.json from the #+INCLUDE files

Reviewers:
  doc-review people list [--archived]               --archived: archived people too
  doc-review people add "Name" [--email E] [--replies instant|daily|never] [--versions]
  doc-review people set ID [--name N] [--email E] [--replies instant|daily|never] [--versions | --no-versions]
                                       --email "" removes the address
  doc-review people remove ID                        delete someone who never commented (with their invitations)
  doc-review people archive ID | unarchive ID        revoke every invitation and hide them / list them again
  doc-review invite [-d DOC] (--person ID | "Name" [--email E]) [--role ROLE] [--send-link]
  doc-review invitations list [-d DOC]
  doc-review invitations role ID "Role"
  doc-review invitations rotate ID [--send-link]     new link; the old one and its sessions stop working
  doc-review invitations revoke ID
  doc-review sessions close-all [--reviewers]        end your web sessions (and the reviewers')
`;

const run = promisify(execFile);

type Values = Record<string, string | boolean | undefined>;

function args(rest: string[], options: Record<string, { type: "string" | "boolean"; short?: string }>) {
  const r = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { url: { type: "string" }, doc: { type: "string", short: "d" }, ...options },
  });
  return { values: r.values as Values, positionals: r.positionals };
}

async function project(): Promise<ProjectConfig | null> {
  return findProjectConfig(process.cwd());
}

async function client(values: Values, proj?: ProjectConfig | null): Promise<Client> {
  const url = (values.url as string | undefined) ?? proj?.url;
  return new Client(await loadClientConfig(undefined, url));
}

function docOf(values: Values, proj: ProjectConfig | null): string {
  const d = (values.doc as string | undefined) ?? process.env.DOC_REVIEW_DOCUMENT ?? proj?.document;
  if (!d) throw new Error("which document? use -d SLUG (or DOC_REVIEW_DOCUMENT, or \"document\" in .doc-review.json)");
  return d;
}

const exists = async (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** progress of .doc-review.json: a file, a command printing JSON, or {command, file}. */
async function projectProgress(proj: ProjectConfig): Promise<{ path: string } | { json: string } | null> {
  const p = proj.progress;
  if (!p) return null;
  const at = (f: string) => (isAbsolute(f) ? f : join(proj.root, f));
  const sh = (cmd: string) => run("/bin/sh", ["-c", cmd], { cwd: proj.root, maxBuffer: 4 * 1024 * 1024 });
  if (typeof p === "string") {
    if (await exists(at(p))) return { path: at(p) };
    return { json: (await sh(p)).stdout };
  }
  if (p.command) await sh(p.command);
  return p.file ? { path: at(p.file) } : null;
}

const line = (...xs: unknown[]) => xs.map((x) => oneLine(String(x ?? ""))).join("\t");

interface Doc {
  slug: string;
  title: string;
  language: string;
  visibility: string;
  archived: boolean;
  role?: string;
  latest_version?: { number: number } | null;
  open_threads?: number;
  reviewers?: number;
}
interface Person {
  id: number;
  name: string;
  email: string | null;
  notify_replies: string;
  notify_versions: boolean;
  archived?: boolean;
  invitations?: { id: number; document: string; role: string; active: boolean }[];
}
interface Inv {
  id: number;
  role: string;
  active: boolean;
  person: Person;
  last_seen_at: string | null;
}
type LinkReply = { invitation: Inv; link: string; email: { sent: boolean; error?: string } };

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
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "no pending migrations");
      return 0;
    }

    case "gen-token": {
      const token = newOwnerToken();
      console.log(`token (for ~/.config/doc-review/config.json):\n  ${token}`);
      console.log(`OWNER_TOKEN_SHA256 (for the server's Secret):\n  ${sha256Hex(token)}`);
      return 0;
    }

    case "progress": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { output: { type: "string", short: "o" } } });
      const root = positionals[0];
      if (!root) throw new Error("usage: doc-review progress ROOT.org [-o progress.json]");
      const out = JSON.stringify(await progressFromOrg(root), null, 2) + "\n";
      if (values.output) await writeFile(values.output, out);
      else process.stdout.write(out);
      return 0;
    }

    case "documents": {
      const [sub = "list", ...more] = rest;
      const { values, positionals } = args(more, {
        language: { type: "string" },
        visibility: { type: "string" },
        "default-role": { type: "string" },
        slug: { type: "string" },
      });
      const c = await client(values, await project());
      const settings = () => ({
        ...(values.language !== undefined ? { language: values.language } : {}),
        ...(values.visibility !== undefined ? { visibility: values.visibility } : {}),
        ...(values["default-role"] !== undefined ? { default_role: values["default-role"] } : {}),
      });
      const show = (d: Doc) => console.log(`${d.slug}: ${oneLine(d.title)} (${d.language}, visibility ${d.visibility}${d.archived ? ", archived" : ""})`);
      const slugArg = (usage: string) => {
        const s = positionals[0];
        if (!s) throw new Error(`usage: doc-review documents ${usage}`);
        return encodeURIComponent(s);
      };
      switch (sub) {
        case "list": {
          const { documents } = await c.request<{ documents: Doc[] }>("GET", "/api/documents");
          console.log(line("SLUG", "TITLE", "LATEST", "OPEN", "REVIEWERS", "STATE"));
          for (const d of documents) {
            console.log(line(d.slug, d.title, d.latest_version ? `v${d.latest_version.number}` : "-", d.open_threads ?? "", d.reviewers ?? "", d.archived ? "archived" : "active"));
          }
          return 0;
        }
        case "create": {
          const [s, title] = positionals;
          if (!s || !title) throw new Error('usage: doc-review documents create SLUG "Title" [--language en|es] [--visibility all|own] [--default-role ROLE]');
          const r = await c.json<{ document: Doc & { url: string } }>("POST", "/api/documents", { slug: s, title, ...settings() });
          show(r.document);
          console.log(r.document.url);
          return 0;
        }
        case "rename": {
          const s = slugArg('rename SLUG "New title" [--slug NEW-SLUG]');
          const title = positionals[1];
          if (!title && values.slug === undefined) throw new Error('usage: doc-review documents rename SLUG "New title" [--slug NEW-SLUG]');
          const r = await c.json<{ document: Doc }>("PATCH", `/api/documents/${s}`, {
            ...(title ? { title } : {}),
            ...(values.slug !== undefined ? { slug: values.slug } : {}),
          });
          show(r.document);
          return 0;
        }
        case "set": {
          const s = slugArg("set SLUG [--language en|es] [--visibility all|own] [--default-role ROLE]");
          show((await c.json<{ document: Doc }>("PATCH", `/api/documents/${s}`, settings())).document);
          return 0;
        }
        case "archive":
        case "unarchive": {
          const s = slugArg(`${sub} SLUG`);
          show((await c.json<{ document: Doc }>("POST", `/api/documents/${s}/${sub}`, {})).document);
          return 0;
        }
      }
      throw new Error(`unknown command: documents ${sub}`);
    }

    case "publish": {
      const { values, positionals } = args(rest, { message: { type: "string", short: "m" } });
      const proj = await project();
      const doc = docOf(values, proj);
      let [pdf, progressFile] = positionals;
      let progress: { path: string } | { json: string } | null = progressFile ? { path: progressFile } : null;
      if (!pdf) {
        if (!proj?.pdf?.length) throw new Error("usage: doc-review publish FILE.pdf [PROGRESS.json] [-m NOTE] [-d DOC] (or \"pdf\" in .doc-review.json)");
        const found = await projectPdf(proj);
        if (!found) throw new Error(`no PDF matches "pdf" in .doc-review.json (${[proj.pdf].flat().join(", ")}): build the document first`);
        pdf = found;
        if (Array.isArray(proj.pdf) || /[*?]/.test(proj.pdf)) console.log(`publishing ${pdf} (the newest match of "pdf")`);
        progress = await projectProgress(proj);
      }
      const c = await client(values, proj);
      const r = await c.publish(doc, pdf, progress, (values.message as string | undefined) ?? "");
      console.log(`published version ${r.version.number} (${r.version.page_count} pages): ${r.url}`);
      return 0;
    }

    case "comments": {
      const { values } = args(rest, { version: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } });
      const proj = await project();
      const c = await client(values, proj);
      const { threads } = await c.threads(docOf(values, proj), { version: values.version as string | undefined, status: values.all ? "all" : "open" });
      if (values.json) console.log(JSON.stringify(threads, null, 2));
      else if (threads.length === 0) console.log(values.all ? "no comments" : "no open comments");
      else console.log(threads.map(fmtThread).join("\n\n"));
      return 0;
    }

    case "people": {
      const [sub = "list", ...more] = rest;
      const { values, positionals } = args(more, {
        name: { type: "string" },
        email: { type: "string" },
        replies: { type: "string" },
        versions: { type: "boolean" },
        "no-versions": { type: "boolean" },
        archived: { type: "boolean" },
      });
      const c = await client(values, await project());
      const show = (p: Person) => console.log(`person ${p.id}: ${oneLine(p.name)}${p.email ? ` <${oneLine(p.email)}>` : ""} (replies: ${p.notify_replies}, versions: ${p.notify_versions ? "yes" : "no"})`);
      if (sub === "list") {
        const { people } = await c.request<{ people: Person[] }>("GET", `/api/people${values.archived ? "?archived=1" : ""}`);
        console.log(line("ID", "NAME", "EMAIL", "REPLIES", "VERSIONS", "DOCUMENTS"));
        for (const p of people) {
          const docs = (p.invitations ?? []).map((i) => `${i.document}${i.role ? `:${i.role}` : ""}${i.active ? "" : "(revoked)"}`).join(", ");
          console.log(line(p.id, `${p.name}${p.archived ? " (archived)" : ""}`, p.email ?? "", p.notify_replies, p.notify_versions ? "yes" : "no", docs));
        }
        return 0;
      }
      if (sub === "remove" || sub === "archive" || sub === "unarchive") {
        const id = Number(positionals[0]);
        if (!Number.isInteger(id) || id < 1) throw new Error(`usage: doc-review people ${sub} ID`);
        if (sub === "remove") {
          try {
            await c.request("DELETE", `/api/people/${id}`);
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) throw new Error(`${e.message} (doc-review people archive ${id})`);
            throw e;
          }
          console.log(`person ${id} deleted`);
        } else {
          const r = await c.json<{ person: Person }>("POST", `/api/people/${id}/${sub}`, {});
          console.log(`person ${id} ${sub}d: ${oneLine(r.person.name)}${sub === "archive" ? " (every invitation revoked)" : " (invitations stay revoked: invitations rotate ID reactivates one)"}`);
        }
        return 0;
      }
      const prefs = {
        ...(values.email !== undefined ? { email: values.email } : {}),
        ...(values.replies !== undefined ? { notify_replies: values.replies } : {}),
        ...(values.versions ? { notify_versions: true } : values["no-versions"] ? { notify_versions: false } : {}),
      };
      if (sub === "add") {
        const name = positionals[0];
        if (!name) throw new Error('usage: doc-review people add "Name" [--email E] [--replies instant|daily|never] [--versions]');
        show((await c.json<{ person: Person }>("POST", "/api/people", { name, ...prefs })).person);
        return 0;
      }
      if (sub === "set") {
        const id = Number(positionals[0]);
        if (!Number.isInteger(id)) throw new Error("usage: doc-review people set ID [--name N] [--email E] [--replies R] [--versions | --no-versions]");
        show((await c.json<{ person: Person }>("PATCH", `/api/people/${id}`, { ...(values.name !== undefined ? { name: values.name } : {}), ...prefs })).person);
        return 0;
      }
      throw new Error(`unknown command: people ${sub}`);
    }

    case "invite": {
      const { values, positionals } = args(rest, {
        person: { type: "string" },
        email: { type: "string" },
        role: { type: "string" },
        "send-link": { type: "boolean" },
      });
      const proj = await project();
      const doc = docOf(values, proj);
      if (!values.person && !positionals[0]) throw new Error('usage: doc-review invite [-d DOC] (--person ID | "Name" [--email E]) [--role ROLE] [--send-link]');
      const c = await client(values, proj);
      const r = await c.json<LinkReply>("POST", `/api/documents/${encodeURIComponent(doc)}/invitations`, {
        ...(values.person ? { person_id: Number(values.person) } : { name: positionals[0], email: values.email ?? "" }),
        ...(values.role !== undefined ? { role: values.role } : {}),
        send_link: values["send-link"] === true,
      });
      console.log(`invitation ${r.invitation.id}: ${oneLine(r.invitation.person.name)} (person ${r.invitation.person.id})${r.invitation.role ? `, ${oneLine(r.invitation.role)}` : ""}, document ${doc}`);
      console.log(`link (shown only once): ${r.link}`);
      if (values["send-link"]) console.log(r.email.sent ? "link sent by email" : `the email was not sent: ${oneLine(r.email.error)}`);
      return 0;
    }

    case "invitations": {
      const [sub = "list", ...more] = rest;
      const { values, positionals } = args(more, { "send-link": { type: "boolean" } });
      const proj = await project();
      const c = await client(values, proj);
      if (sub === "list") {
        const doc = docOf(values, proj);
        const { invitations } = await c.request<{ invitations: Inv[] }>("GET", `/api/documents/${encodeURIComponent(doc)}/invitations`);
        console.log(line("ID", "PERSON", "ROLE", "STATE", "LAST VISIT"));
        for (const i of invitations) console.log(line(i.id, `${i.person.name} (${i.person.id})`, i.role, i.active ? "active" : "revoked", i.last_seen_at ?? "never"));
        return 0;
      }
      const id = Number(positionals[0]);
      if (!Number.isInteger(id)) throw new Error(`usage: doc-review invitations ${sub} ID`);
      if (sub === "role") {
        if (positionals[1] === undefined) throw new Error('usage: doc-review invitations role ID "Role"');
        const r = await c.json<{ invitation: Inv }>("PATCH", `/api/invitations/${id}`, { role: positionals[1] });
        console.log(`invitation ${id}: role ${oneLine(r.invitation.role) || "(none)"}`);
        return 0;
      }
      if (sub === "rotate") {
        const r = await c.json<LinkReply>("POST", `/api/invitations/${id}/rotate`, { send_link: values["send-link"] === true });
        console.log(`new link for ${oneLine(r.invitation.person.name)} (the old one no longer works): ${r.link}`);
        if (values["send-link"]) console.log(r.email.sent ? "link sent by email" : `the email was not sent: ${oneLine(r.email.error)}`);
        return 0;
      }
      if (sub === "revoke") {
        const r = await c.json<{ invitation: Inv }>("POST", `/api/invitations/${id}/revoke`, {});
        console.log(`revoked: invitation ${id} of ${oneLine(r.invitation.person.name)}`);
        return 0;
      }
      throw new Error(`unknown command: invitations ${sub}`);
    }

    case "sessions": {
      const { values, positionals } = args(rest, { reviewers: { type: "boolean" } });
      if (positionals[0] !== "close-all") throw new Error("usage: doc-review sessions close-all [--reviewers]");
      const c = await client(values, await project());
      const r = await c.json<{ closed: { owner: number; reviewers: number } }>("POST", "/api/sessions/close-all", { reviewers: values.reviewers === true });
      console.log(`sessions closed: ${r.closed.owner} of yours, ${r.closed.reviewers} of reviewers`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
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
