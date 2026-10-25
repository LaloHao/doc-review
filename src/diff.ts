// What changed between two versions:
// - words per chapter, from avance.json (exact, comes from the org sources);
// - a text diff per chapter, computed here from the text pdf.js extracts from each
//   PDF. Pages are assigned to chapters by finding each chapter's title at the top of
//   a page (after the table of contents); when no chapter can be located the diff is
//   done for the whole document. The diff unit is the sentence, which reads better
//   than a word diff for prose and keeps the output small.

import type { Avance } from "./avance.js";

export interface ChapterPages {
  id: string;
  title: string;
  /** First page (1-based) or null when the title wasn't found. */
  start_page: number | null;
}

/** Lowercase, letters and digits only, single spaces: for fuzzy title matching. */
export function normalizeLoose(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Finds the page where each chapter starts. */
export function locateChapters(pages: string[], avance: Avance): ChapterPages[] {
  const titles = avance.chapters.map((c) => normalizeLoose(c.title));
  const heads = pages.map((p) => normalizeLoose(p.slice(0, 300)));
  const full = pages.map((p) => normalizeLoose(p));
  // A page that mentions many chapter titles is a table of contents.
  const isToc = full.map((p) => titles.filter((t) => t && p.includes(t)).length >= Math.min(3, titles.length) && titles.length > 1);
  let from = 0;
  return avance.chapters.map((c, i) => {
    const t = titles[i]!;
    for (let p = from; p < pages.length && t; p++) {
      if (isToc[p]) continue;
      const head = heads[p]!;
      // Title near the start of the page: "capítulo 1 introducción …".
      const at = head.indexOf(t);
      if (at >= 0 && at < 40) {
        from = p + 1;
        return { id: c.id, title: c.title, start_page: p + 1 };
      }
    }
    return { id: c.id, title: c.title, start_page: null };
  });
}

/** Chapter id of a page, given the located chapter starts (null = before the first). */
export function chapterOfPage(chapters: ChapterPages[], page: number): ChapterPages | null {
  let best: ChapterPages | null = null;
  for (const c of chapters) {
    if (c.start_page !== null && c.start_page <= page && (best === null || c.start_page >= (best.start_page ?? 0))) {
      best = c;
    }
  }
  return best;
}

export type DiffOp = { op: "eq" | "add" | "del"; text: string };

/** Myers O(ND) diff over arrays of strings. Gives up (returns null) past maxD edits. */
export function diffSeq(a: string[], b: string[], maxD = 4000): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // The trace keeps one V array per step: bound its memory (~80 MB).
  maxD = Math.min(maxD, Math.floor(2e7 / (2 * max + 3)));
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;
  // Backtrack.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "eq", text: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "add", text: b[y - 1]! });
      else ops.push({ op: "del", text: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Splits prose into sentences (one line of the PDF text doesn't mean anything). */
export function sentences(text: string): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  return flat
    .split(/(?<=[.!?…:;])\s+(?=[\p{Lu}¿¡(«"\d])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ChapterDiff {
  id: string | null;
  title: string;
  words_before: number | null;
  words_after: number | null;
  words_delta: number | null;
  /** Changed hunks with up to one sentence of context; null = too different to diff. */
  hunks: DiffOp[][] | null;
  added: number;
  removed: number;
}

export interface VersionDiff {
  previous: number;
  mode: "chapters" | "document";
  chapters: ChapterDiff[];
}

/** Groups diff ops into hunks of changes with `context` equal entries around them. */
export function hunks(ops: DiffOp[], context = 1, maxHunks = 40): DiffOp[][] {
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o.op === "eq") return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: DiffOp[][] = [];
  let cur: DiffOp[] | null = null;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = [];
      out.push(cur);
    }
    cur.push({ ...o, text: o.text.length > 600 ? o.text.slice(0, 600) + "…" : o.text });
  });
  return out.slice(0, maxHunks);
}

function textOfRange(pages: string[], from: number | null, to: number | null): string {
  if (from === null) return "";
  return pages.slice(from - 1, to === null ? undefined : to - 1).join("\n");
}

function chapterTexts(pages: string[], chapters: ChapterPages[]): Map<string, string> {
  const located = chapters.filter((c) => c.start_page !== null).sort((a, b) => a.start_page! - b.start_page!);
  const out = new Map<string, string>();
  located.forEach((c, i) => {
    out.set(c.id, textOfRange(pages, c.start_page, located[i + 1]?.start_page ?? null));
  });
  return out;
}

export function diffVersions(
  prev: { number: number; pages: string[]; avance: Avance; chapters: ChapterPages[] },
  next: { pages: string[]; avance: Avance; chapters: ChapterPages[] },
): VersionDiff {
  const prevWords = new Map(prev.avance.chapters.map((c) => [c.id, c.words]));
  const prevTexts = chapterTexts(prev.pages, prev.chapters);
  const nextTexts = chapterTexts(next.pages, next.chapters);
  const located = nextTexts.size > 0 && prevTexts.size > 0;

  const diffText = (a: string, b: string) => {
    const ops = diffSeq(sentences(a), sentences(b));
    if (!ops) return { hunks: null, added: 0, removed: 0 };
    return {
      hunks: hunks(ops),
      added: ops.filter((o) => o.op === "add").length,
      removed: ops.filter((o) => o.op === "del").length,
    };
  };

  const ids = new Set([...next.avance.chapters.map((c) => c.id), ...prev.avance.chapters.map((c) => c.id)]);
  const titles = new Map([...prev.avance.chapters, ...next.avance.chapters].map((c) => [c.id, c.title]));
  const nextWords = new Map(next.avance.chapters.map((c) => [c.id, c.words]));
  const chapters: ChapterDiff[] = [...ids].map((id) => {
    const before = prevWords.get(id) ?? null;
    const after = nextWords.get(id) ?? null;
    const d = located && (prevTexts.has(id) || nextTexts.has(id))
      ? diffText(prevTexts.get(id) ?? "", nextTexts.get(id) ?? "")
      : { hunks: [], added: 0, removed: 0 };
    return {
      id,
      title: titles.get(id) ?? id,
      words_before: before,
      words_after: after,
      words_delta: before === null && after === null ? null : (after ?? 0) - (before ?? 0),
      ...d,
    };
  });

  if (!located) {
    const d = diffText(prev.pages.join("\n"), next.pages.join("\n"));
    chapters.push({ id: null, title: "Documento completo", words_before: null, words_after: null, words_delta: null, ...d });
    return { previous: prev.number, mode: "document", chapters };
  }
  return { previous: prev.number, mode: "chapters", chapters };
}
