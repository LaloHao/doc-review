// Pieces shared by several pages: the progress table, the diff, labels.

import type { VersionDiff } from "../../diff.js";
import type { MsgKey, Tr } from "../../i18n/index.js";
import type { Progress, SectionStatus } from "../../progress.js";
import type { ReplyNotify, Visibility } from "../../repo.js";
import { esc } from "../../text.js";

export const STATUS_KEY: Record<SectionStatus, MsgKey> = {
  draft: "status.draft",
  review: "status.review",
  done: "status.done",
};

export const REPLY_KEY: Record<ReplyNotify, MsgKey> = {
  instant: "notify.instant",
  daily: "notify.daily",
  never: "notify.never",
};

export const VISIBILITY_KEY: Record<Visibility, MsgKey> = {
  all: "visibility.all",
  own: "visibility.own",
};

/** Suggested role labels (free text; these are only the datalist). */
export const ROLE_KEYS: MsgKey[] = ["role.director", "role.codirector", "role.reviewer", "role.client", "role.coauthor"];

export function roleDatalist(tr: Tr, id = "role-suggestions"): string {
  return `<datalist id="${id}">${ROLE_KEYS.map((k) => `<option value="${tr.e(k)}">`).join("")}</datalist>`;
}

const signed = (tr: Tr, n: number) => `${n > 0 ? "+" : ""}${tr.num(n)}`;

export function progressTable(tr: Tr, progress: Progress | null, prev: Progress | null): string {
  if (!progress) return `<p class="muted">${tr.e("progress.none")}</p>`;
  const prevWords = new Map(prev?.sections.map((c) => [c.id, c.words]) ?? []);
  const rows = progress.sections
    .map((c) => {
      const pct = c.goal ? Math.min(100, Math.round((c.words / c.goal) * 100)) : null;
      const before = prevWords.get(c.id);
      const delta = before === undefined ? null : c.words - before;
      return `<tr>
        <td>${esc(c.title)}</td>
        <td class="num">${tr.num(c.words)}</td>
        <td class="num">${delta === null ? "—" : `<span class="${delta > 0 ? "plus" : delta < 0 ? "minus" : ""}">${signed(tr, delta)}</span>`}</td>
        <td class="num">${c.goal ? tr.num(c.goal) : "—"}</td>
        <td>${pct === null ? "" : `<progress max="100" value="${pct}"></progress> <span class="muted">${tr.e("progress.percent", { pct })}</span>`}</td>
        <td>${c.status ? `<span class="tag tag-${esc(c.status)}">${tr.e(STATUS_KEY[c.status])}</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  const total = prev ? signed(tr, progress.total_words - prev.total_words) : "—";
  return `<table class="progress">
    <thead><tr><th>${tr.e("progress.section")}</th><th class="num">${tr.e("progress.words")}</th><th class="num">${tr.e("progress.change")}</th><th class="num">${tr.e("progress.goal")}</th><th>${tr.e("progress.progress")}</th><th>${tr.e("progress.status")}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>${tr.e("progress.total")}</th><th class="num">${tr.num(progress.total_words)}</th><th class="num">${total}</th><th colspan="3"></th></tr></tfoot>
  </table>`;
}

/** Overall progress: total words and, with goals, the share of the goals reached. */
export function progressSummary(tr: Tr, progress: Progress | null): string {
  if (!progress) return `<span class="muted">—</span>`;
  const goals = progress.sections.reduce((s, c) => s + (c.goal ?? 0), 0);
  const reached = progress.sections.reduce((s, c) => s + (c.goal ? Math.min(c.words, c.goal) : 0), 0);
  const pct = goals ? Math.round((reached / goals) * 100) : null;
  return `${tr.e("progress.words_n", { n: progress.total_words })}${pct === null ? "" : ` · <progress max="100" value="${pct}"></progress> ${tr.e("progress.percent", { pct })}`}`;
}

export function diffHtml(tr: Tr, diff: VersionDiff | null): string {
  if (!diff) return `<p class="muted">${tr.e("diff.first")}</p>`;
  const sections = diff.sections
    .filter((c) => c.hunks === null || c.hunks.length > 0 || (c.words_delta ?? 0) !== 0)
    .map((c) => {
      const head = `<summary><strong>${c.id === null ? tr.e("diff.whole") : esc(c.title)}</strong>
        ${c.words_delta === null ? "" : `<span class="${c.words_delta > 0 ? "plus" : c.words_delta < 0 ? "minus" : "muted"}">${tr.e("diff.words", { n: c.words_delta, signed: signed(tr, c.words_delta) })}</span>`}
        ${c.hunks ? `<span class="muted">· ${tr.e("diff.sentences", { added: c.added, removed: c.removed })}</span>` : ""}</summary>`;
      const body =
        c.hunks === null
          ? `<p class="muted">${tr.e("diff.too_different")}</p>`
          : c.hunks.length === 0
            ? `<p class="muted">${tr.e("diff.no_text_changes")}</p>`
            : c.hunks
                .map(
                  (h) =>
                    `<div class="hunk">${h
                      .map((o) => `<p class="d-${o.op}">${o.op === "add" ? "+ " : o.op === "del" ? "− " : ""}${esc(o.text)}</p>`)
                      .join("")}</div>`,
                )
                .join("");
      return `<details class="section-diff">${head}${body}</details>`;
    })
    .join("");
  return `<p class="muted">${tr.e(diff.mode === "document" ? "diff.compared_document" : "diff.compared", { n: diff.previous })}</p>${sections || `<p class="muted">${tr.e("diff.none")}</p>`}`;
}
