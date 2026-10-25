// avance.json: progress per chapter, uploaded with each PDF.
//
// {"schema":1,"title":…,"generated_at":ISO,"total_words":N,
//  "chapters":[{"id":"01-introduccion","title":"Introducción","words":N,
//               "goal":N|null,"status":"borrador"|"revision"|"terminado"|null}]}

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const CHAPTER_STATUSES = ["borrador", "revision", "terminado"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export interface AvanceChapter {
  id: string;
  title: string;
  words: number;
  goal: number | null;
  status: ChapterStatus | null;
}

export interface Avance {
  schema: 1;
  title: string;
  generated_at: string;
  total_words: number;
  chapters: AvanceChapter[];
}

export class ValidationError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e8;

/** Validates untrusted JSON and returns a clean copy (unknown keys dropped). */
export function validateAvance(input: unknown): Avance {
  const fail = (msg: string): never => {
    throw new ValidationError(`avance.json: ${msg}`);
  };
  if (!isObj(input)) fail("must be a JSON object");
  const o = input as Record<string, unknown>;
  if (o.schema !== 1) fail("schema must be 1");
  if (typeof o.title !== "string" || o.title.trim() === "" || o.title.length > 500) fail("title must be a non-empty string (≤ 500)");
  if (typeof o.generated_at !== "string" || Number.isNaN(Date.parse(o.generated_at))) fail("generated_at must be an ISO date");
  if (!isCount(o.total_words)) fail("total_words must be a non-negative integer");
  if (!Array.isArray(o.chapters) || o.chapters.length > 200) fail("chapters must be an array (≤ 200)");
  const ids = new Set<string>();
  const chapters = (o.chapters as unknown[]).map((c, i): AvanceChapter => {
    if (!isObj(c)) return fail(`chapters[${i}] must be an object`);
    if (typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(c.id)) fail(`chapters[${i}].id must match [A-Za-z0-9_.-]+`);
    if (ids.has(c.id as string)) fail(`chapters[${i}].id is repeated`);
    ids.add(c.id as string);
    if (typeof c.title !== "string" || c.title.trim() === "" || c.title.length > 300) fail(`chapters[${i}].title must be a non-empty string`);
    if (!isCount(c.words)) fail(`chapters[${i}].words must be a non-negative integer`);
    if (!(c.goal === null || c.goal === undefined || (isCount(c.goal) && c.goal > 0))) fail(`chapters[${i}].goal must be a positive integer or null`);
    if (!(c.status === null || c.status === undefined || CHAPTER_STATUSES.includes(c.status as ChapterStatus))) {
      fail(`chapters[${i}].status must be borrador, revision, terminado or null`);
    }
    return {
      id: c.id as string,
      title: (c.title as string).trim(),
      words: c.words as number,
      goal: (c.goal as number | null | undefined) ?? null,
      status: (c.status as ChapterStatus | null | undefined) ?? null,
    };
  });
  return {
    schema: 1,
    title: (o.title as string).trim(),
    generated_at: new Date(o.generated_at as string).toISOString(),
    total_words: o.total_words as number,
    chapters,
  };
}

// --- Generating avance.json from the org sources (CLI: revision-tesis avance) ---

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

function keyword(src: string, name: string): string | null {
  const m = new RegExp(`^[ \\t]*#\\+${name}:[ \\t]*(.*)$`, "im").exec(src);
  return m && m[1] !== undefined ? m[1].trim() : null;
}

/**
 * Builds avance.json from a thesis root file (tesis.org): one chapter per
 * `#+INCLUDE:` file. Per-file goal and status come from optional keywords
 * `#+AVANCE_META: 6000` and `#+AVANCE_ESTADO: borrador|revision|terminado`.
 */
export async function avanceFromOrg(rootFile: string, now = new Date()): Promise<Avance> {
  const root = await readFile(rootFile, "utf8");
  const title = keyword(root, "TITLE") ?? basename(rootFile, ".org");
  const chapters: AvanceChapter[] = [];
  const includeRe = /^[ \t]*#\+INCLUDE:[ \t]*"([^"]+\.org)"/gim;
  for (const m of root.matchAll(includeRe)) {
    const file = join(dirname(rootFile), m[1]!);
    const src = await readFile(file, "utf8");
    const heading = /^\*+\s+(.+?)(\s+:[\w:]+:)?\s*$/m.exec(src);
    const goal = keyword(src, "AVANCE_META");
    const status = keyword(src, "AVANCE_ESTADO");
    chapters.push({
      id: basename(file, ".org"),
      title: heading?.[1]?.trim() ?? basename(file, ".org"),
      words: countWords(orgProse(src)),
      goal: goal && /^\d+$/.test(goal) && Number(goal) > 0 ? Number(goal) : null,
      status: CHAPTER_STATUSES.includes(status as ChapterStatus) ? (status as ChapterStatus) : null,
    });
  }
  return validateAvance({
    schema: 1,
    title,
    generated_at: now.toISOString(),
    total_words: chapters.reduce((s, c) => s + c.words, 0),
    chapters,
  });
}
