# Emacs client

`emacs/doc-review.el` publishes your document, shows the reviewers' comments in
an org buffer linked to the matching place in your sources (org, LaTeX or
Markdown), lets you reply and resolve, and shows the open comments as Flymake
notes on the text. Pure Emacs Lisp (url.el, native JSON); Emacs 29 or newer.

- [Installation](#installation): [vanilla Emacs](#vanilla-emacs), [Doom Emacs](#doom-emacs)
- [The project file, .doc-review.json](#the-project-file-doc-reviewjson)
- [Commands and keys](#commands-and-keys)
- [The comments buffer](#the-comments-buffer)
- [Flymake notes](#flymake-notes)
- [How comments are anchored](#how-comments-are-anchored)
- [Workflows](#workflows)

## Installation

You need the owner token in `~/.config/doc-review/config.json`, mode 0600 (see
[usage.md](usage.md#first-setup)):

```json
{"url": "https://review.example.com", "token": "dr_owner_…"}
```

### Vanilla Emacs

```elisp
(add-to-list 'load-path "~/dev/lalohao/doc-review/emacs")
(require 'doc-review)
;; Optional:
;; (setopt doc-review-keymap-prefix "C-c d")   ; the default; nil binds nothing
;; (setopt doc-review-language 'es)            ; messages in Spanish
(dolist (hook '(org-mode-hook LaTeX-mode-hook latex-mode-hook markdown-mode-hook))
  (add-hook hook #'doc-review-maybe-enable))   ; Flymake notes in the project's sources
```

All commands are under `C-c d` (`doc-review-command-map`). To use another
prefix, `(setopt doc-review-keymap-prefix "C-c r")`; to bind the map yourself,
set it to `nil` and `(keymap-set some-map "C-c r" 'doc-review-command-map)`.

### Doom Emacs

In `~/.config/doom/config.el` (no `doom sync` needed: it isn't a downloaded
package; reload the config):

```elisp
;; doc-review: reviewers' comments on my documents, next to the sources. SPC m z …
(use-package! doc-review
  :load-path "~/dev/lalohao/doc-review/emacs"
  :commands (doc-review-publish doc-review-comments doc-review-reply
             doc-review-resolve doc-review-reopen doc-review-refresh
             doc-review-list-documents doc-review-open-in-browser doc-review-mode)
  :hook ((org-mode latex-mode LaTeX-mode markdown-mode) . doc-review-maybe-enable)
  :init
  ;; Under the localleader instead of C-c d; messages in Spanish.
  (setq doc-review-keymap-prefix nil
        doc-review-language 'es))

;; Localleader "z": free in Doom's Org module (which uses a b c d g i l m p P r s
;; t and single keys such as A e f h I k K n o q t T x), in LaTeX and Markdown,
;; and apart from "w" (research) and "u" (thesis tools).
(map! :after doc-review
      :map (org-mode-map latex-mode-map LaTeX-mode-map markdown-mode-map)
      :localleader
      (:prefix ("z" . "review (doc-review)")
       :desc "Publish version"        "p" #'doc-review-publish
       :desc "Comments"               "c" #'doc-review-comments
       :desc "Reply to thread"        "r" #'doc-review-reply
       :desc "Resolve thread"         "x" #'doc-review-resolve
       :desc "Reopen thread"          "X" #'doc-review-reopen
       :desc "Refresh comments"       "g" #'doc-review-refresh
       :desc "Notes in the text"      "m" #'doc-review-mode
       :desc "My documents"           "l" #'doc-review-list-documents
       :desc "Open in the browser"    "b" #'doc-review-open-in-browser))
```

`doc-review-maybe-enable` (on the mode hooks) loads the package when you open a
source file of a project, so the localleader keys exist from then on. The
comments buffer has its own evil keys (below); it doesn't need the localleader.

## The project file, .doc-review.json

At the root of the project (found with `locate-dominating-file` from the
current file or directory):

```json
{
  "document": "thesis",
  "pdf": "tesis.pdf",
  "progress": {"command": "make avance", "file": "avance.json"},
  "sources": ["tesis.org", "capitulos/*.org"],
  "url": "https://review.example.com"
}
```

| Key | | |
|---|---|---|
| `document` | required | The document's short name on the server |
| `pdf` | for publishing | The built PDF, relative to the root |
| `progress` | optional | A file (`"avance.json"`), a shell command that prints progress.json (`"doc-review progress tesis.org"`), or `{"command": …, "file": …}` (run the command in the root, then send the file) |
| `sources` | optional | Globs of the source files, relative to the root (`*`, `?` and `**/`); default `**/*.org`, `**/*.tex`, `**/*.md`. Hidden directories are skipped |
| `url` | optional | The server; default the one in `config.json`. Its token must be in `config.json` (`"servers": {"https://…": "dr_owner_…"}`): a project file can't send your token to another server |

The CLI reads the same file (`doc-review publish`, `comments`, `invite`,
`invitations list` default to its document). A `progress` command runs with
your shell, like a Makefile target: only use project files you trust.

Examples:

```json
{"document": "acme-q3", "pdf": "build/report.pdf", "sources": ["chapters/*.tex", "main.tex"]}
{"document": "paper", "pdf": "paper.pdf", "progress": "progress.json", "sources": ["paper.md"]}
```

## Commands and keys

| Command | Vanilla | Doom | |
|---|---|---|---|
| `doc-review-publish` | `C-c d p` | `SPC m z p` | Upload the PDF (and progress) as a new version; asks for a note; warns if the PDF is older than the sources |
| `doc-review-comments` | `C-c d c` | `SPC m z c` | The open threads in an org buffer (`C-u`: all, resolved too) |
| `doc-review-reply` | `C-c d r` | `SPC m z r` | Reply to the thread at point (a heading of the comments buffer, a Flymake note, or chosen from a list) |
| `doc-review-resolve` | `C-c d x` | `SPC m z x` | Mark the thread at point resolved (`C-u`: reopen) |
| `doc-review-reopen` | `C-c d X` | `SPC m z X` | Reopen the thread at point |
| `doc-review-refresh` | `C-c d g` | `SPC m z g` | Fetch the comments again (buffer and Flymake notes) |
| `doc-review-mode` | `C-c d m` | `SPC m z m` | Toggle the Flymake notes in this buffer |
| `doc-review-list-documents` | `C-c d l` | `SPC m z l` | Your documents on the server (RET: open in the browser, `g`: refresh) |
| `doc-review-open-in-browser` | `C-c d b` | `SPC m z b` | The thread at point, or the document (`C-u`: its management page) |

Messages are in English by default; `(setq doc-review-language 'es)` for
Spanish (the server's error messages follow the same setting).

## The comments buffer

`*doc-review: <document>*` is a read-only org buffer (`doc-review-comments-mode`,
derived from `org-mode`): one heading per section, one subheading per thread
(page, version, author and role), a link to the place in the sources, a link to
the thread on the web, the quote and the comments as fixed-width text (reviewers'
text can't become a link or markup).

| Key (vanilla) | Key (evil normal/motion) | |
|---|---|---|
| `RET` | `RET` | Open the source at the commented line (or the section's file) |
| `o` | `o` | Open the thread in the browser |
| `r` | `r` | Reply |
| `x` | `x` | Resolve (`C-u x`: reopen) |
| `X` | `X` | Reopen |
| `g` | `g r` | Refresh |
| `n` / `p` | `]]` / `[[` | Next / previous thread |
| `q` | `q` | Quit |
| `TAB` | `TAB` | Fold (org) |

With evil, the keys are set in the buffer's local normal and motion state maps,
which come before minor modes such as evil-org: evil's normal state no longer
shadows them, and `gg`, `G`, search and the rest of evil keep working.

## Flymake notes

`doc-review-mode` (turned on by `doc-review-maybe-enable` in the project's
source files) shows each open comment as a Flymake note on the quoted text. The
comments are fetched in the background when you open a file; `doc-review-refresh`
fetches them again. If the fetch fails (a wrong token, the server down) the
reason appears in the echo area. With the cursor on a note, `doc-review-reply`
and `doc-review-resolve` act on that thread. Doom uses Flycheck for other
checks; Flymake works alongside.

## How comments are anchored

Only letters and digits are compared (no spaces, hyphenation, ligatures or
punctuation), after removing from the source what isn't in the PDF:

- **org**: drawers, comments and `#+` keywords, comment/src/example blocks,
  `[cite:…]`, link targets, LaTeX command names (`\gls{LLM}` counts as «LLM»),
  heading tags;
- **LaTeX**: `%` comments, `\cite`, `\label`, `\ref`, `\includegraphics` and
  other non-text commands with their arguments, other command names (their
  arguments stay);
- **Markdown**: front matter, HTML comments and tags, code fences, link targets,
  reference definitions, `[@citations]`.

The file named after the thread's section id is tried first. Without an exact
match (you edited the paragraph after building the PDF, or the PDF expanded an
acronym), the place where most 12-character pieces of the quote fall together
wins. Quotes shorter than 8 letters aren't anchored; those and point comments go
to «Not located in the sources», with a link to the section's file.

## Workflows

**Publish a new version of the thesis** (template with `make avance`):

```
SPC m z p        ; runs "make avance", uploads tesis.pdf + avance.json, asks for a note
```

**Go through the comments**:

```
SPC m z c        ; the comments buffer
]] RET           ; next thread, jump to the source line; edit the text
SPC m z r        ; (back in the comments buffer: r) reply
x                ; resolve it
g r              ; refresh
```

**Work in the source with notes**: open a chapter; the commented passages are
underlined as Flymake notes; `M-x flymake-goto-next-error` moves between them,
`SPC m z r` replies to the one at point.

**Several documents**: each project has its own `.doc-review.json`; `SPC m z l`
lists all your documents on the server.
