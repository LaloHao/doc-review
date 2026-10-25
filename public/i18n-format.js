// Message formatting for the browser: the same code as src/i18n/format.ts
// (a test keeps them equal). `{name}` placeholders and
// `{n, plural, one {# comment} other {# comments}}`.

const pluralRules = new Map();

function plural(locale, n) {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r.select(n);
}

/** Index of the "}" that closes the "{" at `open`, or -1. */
function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

export function formatMessage(template, params, locale) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = closing(template, open);
    if (close < 0) {
      out += template.slice(open);
      break;
    }
    const inner = template.slice(open + 1, close);
    const m = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (m) {
      const n = Number(params[m[1]] ?? 0);
      const cases = new Map();
      const body = m[2];
      let j = 0;
      while (j < body.length) {
        const sel = /^\s*(=?\w+)\s*\{/.exec(body.slice(j));
        if (!sel) break;
        const start = j + sel[0].length - 1;
        const end = closing(body, start);
        if (end < 0) break;
        cases.set(sel[1], body.slice(start + 1, end));
        j = end + 1;
      }
      const chosen = cases.get(`=${n}`) ?? cases.get(plural(locale, n)) ?? cases.get("other") ?? "";
      out += formatMessage(chosen.replace(/#/g, n.toLocaleString(locale)), params, locale);
    } else {
      const v = params[inner.trim()];
      out += v === undefined ? template.slice(open, close + 1) : typeof v === "number" ? v.toLocaleString(locale) : v;
    }
    i = close + 1;
  }
  return out;
}
