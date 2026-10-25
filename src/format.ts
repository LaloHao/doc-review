// Terminal output of the CLI. Everything that comes from the server is untrusted:
// control and bidi characters are removed before printing.

import type { ThreadJson } from "./client.js";
import { cleanText } from "./text.js";

const timeFmt = new Intl.DateTimeFormat("es-MX", { dateStyle: "short", timeStyle: "short" });
const localTime = (iso: string) => timeFmt.format(new Date(iso));

/** One line of untrusted text, safe for a terminal. */
export const oneLine = (s: string | null | undefined) => cleanText(s ?? "").replace(/\s+/g, " ").trim();

export function fmtThread(t: ThreadJson): string {
  const lines = [
    `#${t.id} · v${t.version} p. ${t.page}${t.section ? ` · ${oneLine(t.section.title)}` : ""} · ${t.status === "open" ? "abierto" : "resuelto"}`,
  ];
  if (t.quote) lines.push(`  «${oneLine(t.quote).slice(0, 200)}»`);
  for (const c of t.comments) {
    const body = c.deleted ? "(eliminado)" : cleanText(c.body ?? "").replace(/\t/g, " ").replace(/\n/g, "\n    ");
    lines.push(`  ${oneLine(c.author.name)} (${localTime(c.created_at)}):`, `    ${body}`);
  }
  lines.push(`  ${oneLine(t.url)}`);
  return lines.join("\n");
}

