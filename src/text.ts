// Output encoding. Comments and names are untrusted: everything goes through
// `esc` before reaching HTML. The comment markup is a tiny subset applied to the
// already-escaped text, so it cannot produce anything but the tags below.

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]!);
}

/**
 * Renders a comment body: **bold**, *italic*, `code`, http(s) links, line breaks
 * and paragraphs. Input is escaped first; links only allow http/https.
 */
export function renderComment(body: string): string {
  const paragraphs = body.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return paragraphs
    .map((p) => {
      let h = esc(p);
      const codes: string[] = [];
      h = h.replace(/&#96;([^\n]+?)&#96;/g, (_, c: string) => {
        codes.push(`<code>${c}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
      });
      h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
      h = h.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => `<a href="${url}" rel="noopener noreferrer nofollow" target="_blank">${url}</a>`);
      h = h.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? "");
      return `<p>${h.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

/** Plain-text excerpt for notifications (no markup, bounded length). */
export function excerpt(s: string, max = 300): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
