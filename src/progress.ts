// progress.json: optional progress per section, uploaded with a PDF.
//
// {"schema":1,"title":…,"generated_at":ISO,"total_words":N,
//  "sections":[{"id":"01-introduction","title":"Introduction","words":N,
//               "goal":N|null,"status":"draft"|"review"|"done"|null}]}
//
// The thesis template's `make avance` writes the older shape, avance.json, with
// "chapters" instead of "sections" and Spanish statuses (borrador, revision,
// terminado); it is accepted as an alias and stored in the new shape.

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const SECTION_STATUSES = ["draft", "review", "done"] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/** Statuses of the avance.json alias (and their accented spelling). */
const STATUS_ALIASES: Record<string, SectionStatus> = {
  borrador: "draft",
  revision: "review",
  "revisión": "review",
  terminado: "done",
};

export interface Section {
  id: string;
  title: string;
  words: number;
  goal: number | null;
  status: SectionStatus | null;
}

export interface Progress {
  schema: 1;
  title: string;
  generated_at: string;
  total_words: number;
  sections: Section[];
}

export class ValidationError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e8;

function status(v: unknown): SectionStatus | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  if ((SECTION_STATUSES as readonly string[]).includes(v)) return v as SectionStatus;
  return STATUS_ALIASES[v];
}

/** Validates untrusted JSON (progress.json or avance.json) and returns a clean copy (unknown keys dropped). */
export function validateProgress(input: unknown): Progress {
  const fail = (msg: string): never => {
    throw new ValidationError(`progress.json: ${msg}`);
  };
  if (!isObj(input)) fail("must be a JSON object");
  const o = input as Record<string, unknown>;
  if (o.schema !== 1) fail("schema must be 1");
  if (typeof o.title !== "string" || o.title.trim() === "" || o.title.length > 500) fail("title must be a non-empty string (≤ 500)");
  if (typeof o.generated_at !== "string" || Number.isNaN(Date.parse(o.generated_at))) fail("generated_at must be an ISO date");
  if (!isCount(o.total_words)) fail("total_words must be a non-negative integer");
  const key = o.sections !== undefined ? "sections" : "chapters";
  const list = o[key];
  if (!Array.isArray(list) || list.length > 200) fail("sections must be an array (≤ 200)");
  const ids = new Set<string>();
  const sections = (list as unknown[]).map((c, i): Section => {
    const at = `${key}[${i}]`;
    if (!isObj(c)) return fail(`${at} must be an object`);
    if (typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(c.id)) fail(`${at}.id must match [A-Za-z0-9_.-]+`);
    if (ids.has(c.id as string)) fail(`${at}.id is repeated`);
    ids.add(c.id as string);
    if (typeof c.title !== "string" || c.title.trim() === "" || c.title.length > 300) fail(`${at}.title must be a non-empty string`);
    if (!isCount(c.words)) fail(`${at}.words must be a non-negative integer`);
    if (!(c.goal === null || c.goal === undefined || (isCount(c.goal) && c.goal > 0))) fail(`${at}.goal must be a positive integer or null`);
    const st = status(c.status);
    if (st === undefined) fail(`${at}.status must be draft, review, done or null`);
    return {
      id: c.id as string,
      title: (c.title as string).trim(),
      words: c.words as number,
      goal: (c.goal as number | null | undefined) ?? null,
      status: st ?? null,
    };
  });
  return {
    schema: 1,
    title: (o.title as string).trim(),
    generated_at: new Date(o.generated_at as string).toISOString(),
    total_words: o.total_words as number,
    sections,
  };
}

// --- Generating progress.json from org sources (CLI: doc-review progress) ---

/** Text of an org file as it would be read: no drawers, comments, keywords, markup. */
export function orgProse(src: string): string {
  return src
    .replace(/^[ \t]*#\+begin_(comment|src|example)[\s\S]*?^[ \t]*#\+end_\1.*$/gim, " ")
    .replace(/^[ \t]*:[A-Z_]+:[\s\S]*?^[ \t]*:END:.*$/gm, " ")
    .replace(/^[ \t]*#.*$/gm, " ")
    .replace(/\[cite[^\]]*\]/g, " ")
    .replace(/\[\[[^\]]*\]\[([^\]]*)\]\]/g, "$1")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{([^}]*)\}/g, "$2")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/^(\*+\s+.*?)\s+:[\w@#%:]+:\s*$/gm, "$1")
    .replace(/^\*+\s+/gm, "");
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

function keyword(src: string, ...names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`^[ \\t]*#\\+${name}:[ \\t]*(.*)$`, "im").exec(src);
    if (m && m[1] !== undefined) return m[1].trim();
  }
  return null;
}

/**
 * Builds progress.json from an org root file: one section per `#+INCLUDE:`d
 * file. Per-file goal and status come from optional keywords
 * `#+PROGRESS_GOAL: 6000` and `#+PROGRESS_STATUS: draft|review|done` (the
 * thesis template's `#+AVANCE_META` / `#+AVANCE_ESTADO` also work).
 */
export async function progressFromOrg(rootFile: string, now = new Date()): Promise<Progress> {
  const root = await readFile(rootFile, "utf8");
  const title = keyword(root, "TITLE") ?? basename(rootFile, ".org");
  const sections: Section[] = [];
  const includeRe = /^[ \t]*#\+INCLUDE:[ \t]*"([^"]+\.org)"/gim;
  for (const m of root.matchAll(includeRe)) {
    const file = join(dirname(rootFile), m[1]!);
    const src = await readFile(file, "utf8");
    const heading = /^\*+\s+(.+?)(\s+:[\w:]+:)?\s*$/m.exec(src);
    const goal = keyword(src, "PROGRESS_GOAL", "AVANCE_META");
    const st = status(keyword(src, "PROGRESS_STATUS", "AVANCE_ESTADO")?.toLowerCase() ?? null);
    sections.push({
      id: basename(file, ".org"),
      title: heading?.[1]?.trim() ?? basename(file, ".org"),
      words: countWords(orgProse(src)),
      goal: goal && /^\d+$/.test(goal) && Number(goal) > 0 ? Number(goal) : null,
      status: st ?? null,
    });
  }
  return validateProgress({
    schema: 1,
    title,
    generated_at: now.toISOString(),
    total_words: sections.reduce((s, c) => s + c.words, 0),
    sections,
  });
}
