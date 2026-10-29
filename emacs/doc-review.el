;;; doc-review.el --- Reviewers' comments on your documents, next to the sources -*- lexical-binding: t; -*-

;; Author: Eduardo V.
;; Version: 0.3.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: outlines, tools, wp
;; URL: https://github.com/LaloHao/doc-review

;;; Commentary:

;; Client for a doc-review server, where reviewers comment on the PDF
;; versions of a document.  A project is a directory with a .doc-review.json
;; file at its root:
;;
;;   {"document": "thesis", "pdf": "tesis.pdf", "progress": "avance.json",
;;    "sources": ["tesis.org", "capitulos/*.org"], "url": "https://…"}
;;
;; "progress" is a file, a shell command that prints progress.json, or
;; {"command": "make avance", "file": "avance.json"}; "url" is optional.  The
;; owner token stays in ~/.config/doc-review/config.json ({"url", "token"},
;; or "servers": {"https://…": "token"}), readable only by you.
;;
;;   M-x doc-review-publish           upload the PDF (and progress) as a new version
;;   M-x doc-review-comments          the comments in an org buffer, grouped by
;;                                    section and page, linked to the sources
;;                                    (org, LaTeX, Markdown)
;;   M-x doc-review-reply             reply to the thread at point
;;   M-x doc-review-resolve           resolve the thread at point (C-u: reopen)
;;   M-x doc-review-reopen            reopen the thread at point
;;   M-x doc-review-refresh           fetch the comments again
;;   M-x doc-review-list-documents    your documents on the server
;;   M-x doc-review-open-in-browser   the document (or the thread at point) on the web
;;   doc-review-mode                  open comments as Flymake notes on the text
;;
;; All of them are in `doc-review-command-map', bound to C-c d by default
;; (`doc-review-keymap-prefix').  Comments are anchored in the sources by
;; fuzzy-matching the text the reviewer selected in the PDF: both sides are
;; reduced to lowercase letters and digits, after masking markup, comments and
;; citations in the source.  Pure Emacs Lisp: url.el and native JSON.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'url)
(require 'url-http)
(require 'org)
(require 'flymake)
(require 'tabulated-list)
(require 'ucs-normalize)

(declare-function evil-local-set-key "evil-core" (state key def))
(declare-function evil-define-key* "evil-core" (state keymap key def &rest bindings))
(declare-function evil-set-initial-state "evil-core" (mode state))

(defgroup doc-review nil
  "Reviewers' comments on your documents, next to the sources."
  :group 'tools
  :prefix "doc-review-")

(defcustom doc-review-config-file
  (expand-file-name "doc-review/config.json" (or (getenv "XDG_CONFIG_HOME") "~/.config"))
  "JSON file with the server URL and the owner token: {\"url\": …, \"token\": …}.
Tokens of other servers go in \"servers\": {\"https://…\": \"token\"}."
  :type 'file)

(defcustom doc-review-project-file ".doc-review.json"
  "File at the root of a project: its document, PDF, progress and sources."
  :type 'string)

(defcustom doc-review-language 'en
  "Language of the messages of this package (and of the server's errors)."
  :type '(choice (const :tag "English" en) (const :tag "Español" es)))

(defcustom doc-review-default-sources '("**/*.org" "**/*.tex" "**/*.md")
  "Source globs used when .doc-review.json has no \"sources\"."
  :type '(repeat string))

(defcustom doc-review-timeout 120
  "Seconds to wait for the server."
  :type 'integer)

(defcustom doc-review-min-quote-length 8
  "Quotes shorter than this (letters and digits) are not anchored in the sources."
  :type 'integer)

;;; Messages

(defconst doc-review--messages
  '((en
     (no-config . "%s does not exist: create it with {\"url\": …, \"token\": …} and chmod 600")
     (config-readable . "%s is readable by other users: run chmod 600 %s")
     (config-invalid . "%s must have \"url\" and \"token\"")
     (no-token . "No token for %s in %s (add it under \"servers\")")
     (https-only . "The server URL must use https:// (http only for localhost): %s")
     (no-project . "No %s in this directory or above")
     (project-invalid . "%s is not valid JSON")
     (no-document . "%s has no \"document\"")
     (no-pdf-setting . "%s has no \"pdf\"")
     (no-response . "doc-review: no response from %s")
     (server-error . "doc-review: %s")
     (no-pdf . "%s does not exist: build the document first")
     (no-progress . "%s does not exist")
     (command-failed . "«%s» failed (exit code %s)")
     (pdf-older . "%s is older than the sources. Publish anyway? ")
     (cancelled . "Cancelled")
     (note-prompt . "Version note for %s (optional; M-p: previous notes): ")
     (pdf-prompt . "PDF to publish: ")
     (no-pdf-match . "No PDF matches \"pdf\" of %s (%s): build the document first")
     (publishing . "Publishing %s…")
     (published . "Published version %s (%s pages): %s")
     (reply-prompt . "Reply to thread #%s: ")
     (empty-reply . "Empty reply")
     (replied . "Reply sent to thread #%s")
     (resolved . "Thread #%s resolved")
     (reopened . "Thread #%s reopened")
     (thread-prompt . "Thread: ")
     (no-open-threads . "No open comments")
     (fetched . "%d open comment(s)")
     (fetch-failed . "doc-review: the comments could not be fetched: %s (M-x doc-review-refresh to retry)")
     (no-answer . "no response")
     (buffer-title . "Comments · %s")
     (buffer-count . "%d open thread(s); %d all told.")
     (buffer-count-open . "%d open thread(s).")
     (buffer-keys . "RET: source · r: reply · x: resolve · X: reopen · o: open in browser · g: refresh (evil: gr) · n/p: next/previous (evil: ]] [[) · q: quit")
     (no-section . "No section")
     (unanchored . "Not located in the sources")
     (resolved-tag . "resolved")
     (source . "Source")
     (section-file . "Section file")
     (web . "Web")
     (open-in-pdf . "open in the PDF")
     (quote . "Quote")
     (edited . " (edited)")
     (deleted . "(comment deleted)")
     (diag-messages . ", %d messages")
     (no-source-here . "This thread is not located in the sources")
     (documents-title . "doc-review documents")
     (col-document . "Document")
     (col-title . "Title")
     (col-role . "Language")
     (col-latest . "Latest")
     (col-open . "Open")
     (col-state . "State")
     (archived . "archived")
     (active . "active")
     (no-document-here . "No document on this line"))
    (es
     (no-config . "No existe %s: créalo con {\"url\": …, \"token\": …} y chmod 600")
     (config-readable . "%s es legible por otros usuarios: ejecuta chmod 600 %s")
     (config-invalid . "%s debe tener \"url\" y \"token\"")
     (no-token . "No hay token para %s en %s (agrégalo en \"servers\")")
     (https-only . "La URL del servidor debe usar https:// (http solo para localhost): %s")
     (no-project . "No encontré %s en este directorio ni arriba")
     (project-invalid . "%s no es JSON válido")
     (no-document . "%s no tiene \"document\"")
     (no-pdf-setting . "%s no tiene \"pdf\"")
     (no-response . "doc-review: sin respuesta de %s")
     (server-error . "doc-review: %s")
     (no-pdf . "No existe %s: compila el documento primero")
     (no-progress . "No existe %s")
     (command-failed . "Falló «%s» (código %s)")
     (pdf-older . "%s es más viejo que las fuentes. ¿Publicar de todos modos? ")
     (cancelled . "Cancelado")
     (note-prompt . "Nota de la versión de %s (opcional; M-p: notas anteriores): ")
     (pdf-prompt . "PDF a publicar: ")
     (no-pdf-match . "Ningún PDF coincide con \"pdf\" de %s (%s): compila el documento primero")
     (publishing . "Publicando %s…")
     (published . "Publicada la versión %s (%s páginas): %s")
     (reply-prompt . "Respuesta al hilo #%s: ")
     (empty-reply . "Respuesta vacía")
     (replied . "Respuesta enviada al hilo #%s")
     (resolved . "Hilo #%s resuelto")
     (reopened . "Hilo #%s reabierto")
     (thread-prompt . "Hilo: ")
     (no-open-threads . "No hay comentarios abiertos")
     (fetched . "%d comentario(s) abiertos")
     (fetch-failed . "doc-review: no se pudieron descargar los comentarios: %s (M-x doc-review-refresh para reintentar)")
     (no-answer . "sin respuesta")
     (buffer-title . "Comentarios · %s")
     (buffer-count . "%d hilo(s) abiertos; %d en total.")
     (buffer-count-open . "%d hilo(s) abiertos.")
     (buffer-keys . "RET: fuente · r: responder · x: resolver · X: reabrir · o: abrir en el navegador · g: actualizar (evil: gr) · n/p: siguiente/anterior (evil: ]] [[) · q: salir")
     (no-section . "Sin sección")
     (unanchored . "Sin ubicar en las fuentes")
     (resolved-tag . "resuelto")
     (source . "Fuente")
     (section-file . "Archivo de la sección")
     (web . "Web")
     (open-in-pdf . "ver en el PDF")
     (quote . "Cita")
     (edited . " (editado)")
     (deleted . "(comentario eliminado)")
     (diag-messages . ", %d mensajes")
     (no-source-here . "Este hilo no está ubicado en las fuentes")
     (documents-title . "documentos de doc-review")
     (col-document . "Documento")
     (col-title . "Título")
     (col-role . "Idioma")
     (col-latest . "Última")
     (col-open . "Abiertos")
     (col-state . "Estado")
     (archived . "archivado")
     (active . "activo")
     (no-document-here . "No hay un documento en esta línea")))
  "User-facing messages, by `doc-review-language'.")

(defun doc-review--t (key &rest args)
  "The message KEY in `doc-review-language', formatted with ARGS."
  (let ((m (or (alist-get key (alist-get doc-review-language doc-review--messages))
               (alist-get key (alist-get 'en doc-review--messages))
               (symbol-name key))))
    (if args (apply #'format m args) m)))

;;; Untrusted text

(defconst doc-review--unsafe-chars-regexp
  (rx (any (0 . 8) 11 12 (13 . 31) (127 . 159)
           #x61c #x200e #x200f (#x202a . #x202e) (#x2066 . #x2069)
           ;; Raw bytes left by invalid UTF-8.
           (#x3fff80 . #x3fffff)))
  "Control characters (except tab and newline), bidi controls and raw bytes.")

(defun doc-review--sanitize (s)
  "S without control or bidi characters (text from reviewers is untrusted).
Escape sequences, carriage returns and bidi overrides could make the text
look different from what it is in a buffer, the echo area or Flymake."
  (if (stringp s)
      (replace-regexp-in-string doc-review--unsafe-chars-regexp "" s t t)
    ""))

(defun doc-review--clean-line (s)
  "S safe for one line of an org buffer: no newlines, tabs or link brackets."
  (replace-regexp-in-string "\\[\\[\\|\\]\\]\\|[\n\t]" " " (doc-review--sanitize s)))

(defun doc-review--literal (text &optional indent)
  "TEXT as org fixed-width lines (\": …\"): nothing in it is markup or a link."
  (let ((pad (or indent "")))
    (mapconcat (lambda (l) (concat pad (if (string-empty-p l) ":" (concat ": " l))))
               (split-string (doc-review--sanitize text) "\n") "\n")))

;;; Configuration, project and HTTP

(cl-defstruct (doc-review-project (:constructor doc-review--make-project))
  "A directory with a .doc-review.json."
  root url document pdf progress sources)

(defun doc-review--parse-json (string)
  "Parse STRING as JSON: objects → alists, arrays → lists, null → nil."
  (json-parse-string string :object-type 'alist :array-type 'list
                     :null-object nil :false-object :false))

(defun doc-review--read-json-file (file)
  "FILE parsed as JSON, or a `user-error'."
  (condition-case nil
      (with-temp-buffer
        (insert-file-contents file)
        (doc-review--parse-json (buffer-string)))
    (json-error (user-error (doc-review--t 'project-invalid file)))))

(defun doc-review--check-url (url)
  "URL without trailing slashes; a `user-error' unless https (or local http).
The owner token goes in every request: it must never travel in clear text."
  (let* ((u (url-generic-parse-url url))
         (type (url-type u))
         (host (url-host u)))
    (unless (or (equal type "https")
                (and (equal type "http")
                     (member host '("localhost" "127.0.0.1" "::1" "[::1]"))))
      (user-error (doc-review--t 'https-only url)))
    (string-trim-right url "/+")))

(defun doc-review--origin (url)
  "Scheme, host and port of URL, for comparing servers."
  (let ((u (url-generic-parse-url url)))
    (list (url-type u) (downcase (or (url-host u) "")) (url-port u))))

(defun doc-review--server (&optional project)
  "Return (URL . TOKEN) for PROJECT (its \"url\", or the config's).
The token must be configured for that server's origin: a project file can
pick a server, but can't send your token to another one."
  (let ((file (expand-file-name doc-review-config-file)))
    (unless (file-readable-p file) (user-error (doc-review--t 'no-config file)))
    (let ((modes (file-modes file)))
      (when (and modes (/= 0 (logand modes #o077)))
        (user-error (doc-review--t 'config-readable file file))))
    (let* ((json (doc-review--read-json-file file))
           (curl (alist-get 'url json))
           (ctoken (alist-get 'token json))
           (servers nil))
      (when (and (stringp curl) (stringp ctoken) (> (length curl) 0) (> (length ctoken) 0))
        (push (cons (doc-review--origin (doc-review--check-url curl)) ctoken) servers))
      (dolist (s (alist-get 'servers json))
        (when (and (stringp (cdr s)) (> (length (cdr s)) 0))
          (push (cons (doc-review--origin (doc-review--check-url (symbol-name (car s)))) (cdr s))
                servers)))
      (let ((url (or (and project (doc-review-project-url project)) curl)))
        (unless (and (stringp url) (> (length url) 0))
          (user-error (doc-review--t 'config-invalid file)))
        (let* ((url (doc-review--check-url url))
               (token (cdr (assoc (doc-review--origin url) servers))))
          (unless token (user-error (doc-review--t 'no-token url file)))
          (cons url token))))))

(defun doc-review--project (&optional dir noerror)
  "The project (from .doc-review.json) of DIR or above; nil with NOERROR."
  (let ((root (locate-dominating-file (or dir default-directory) doc-review-project-file)))
    (if (not root)
        (unless noerror (user-error (doc-review--t 'no-project doc-review-project-file)))
      (let* ((root (file-name-as-directory (expand-file-name root)))
             (file (expand-file-name doc-review-project-file root))
             (json (doc-review--read-json-file file))
             (str (lambda (k) (let ((v (alist-get k json))) (and (stringp v) (> (length v) 0) v)))))
        (doc-review--make-project
         :root root
         :url (funcall str 'url)
         :document (funcall str 'document)
         :pdf (let ((v (alist-get 'pdf json)))
                (cond ((and (stringp v) (> (length v) 0)) (list v))
                      ((listp v) (cl-remove-if-not (lambda (x) (and (stringp x) (> (length x) 0))) v))))
         :progress (alist-get 'progress json)
         :sources (cl-remove-if-not #'stringp (let ((s (alist-get 'sources json))) (and (listp s) s))))))))

(defun doc-review--document (project)
  "PROJECT's document slug, or a `user-error'."
  (or (doc-review-project-document project)
      (user-error (doc-review--t 'no-document
                                 (expand-file-name doc-review-project-file (doc-review-project-root project))))))

(defun doc-review--headers (token &optional content-type)
  "Request headers as unibyte strings.
url.el refuses to send a request whose headers are multibyte (strings read
from JSON are) together with a binary body."
  (mapcar (lambda (h) (cons (car h) (encode-coding-string (cdr h) 'utf-8)))
          (append `(("Authorization" . ,(concat "Bearer " token))
                    ("Accept" . "application/json")
                    ("Accept-Language" . ,(symbol-name doc-review-language)))
                  (when content-type `(("Content-Type" . ,content-type))))))

(defun doc-review--handle-response (status text)
  "Return TEXT parsed as JSON, or signal the server's error for STATUS ≥ 400."
  (let ((data (condition-case nil
                  (and (not (string-empty-p (string-trim text)))
                       (doc-review--parse-json text))
                (error nil))))
    (when (or (null status) (>= status 400))
      (user-error (doc-review--t 'server-error
                                 (let ((msg (and (consp data) (alist-get 'error data))))
                                   (if (stringp msg) (doc-review--sanitize msg) (format "HTTP %s" status))))))
    data))

(defun doc-review--request (project method path &optional body content-type)
  "Send METHOD PATH to PROJECT's server with the owner token; return the JSON.
BODY is a unibyte string sent with CONTENT-TYPE."
  (let* ((server (doc-review--server project))
         (url-request-method method)
         (url-request-extra-headers (doc-review--headers (cdr server) content-type))
         (url-request-data body)
         (buffer (url-retrieve-synchronously (concat (car server) path) t t doc-review-timeout)))
    (unless buffer (error (doc-review--t 'no-response (car server))))
    (unwind-protect
        (with-current-buffer buffer
          (let ((status (bound-and-true-p url-http-response-status))
                (text (progn
                        (goto-char (point-min))
                        (if (bound-and-true-p url-http-end-of-headers)
                            (goto-char url-http-end-of-headers)
                          (re-search-forward "\r?\n\r?\n" nil t))
                        (decode-coding-string
                         (buffer-substring-no-properties (point) (point-max)) 'utf-8))))
            (doc-review--handle-response status text)))
      (kill-buffer buffer))))

(defun doc-review--json-body (object)
  "OBJECT as a unibyte UTF-8 JSON string."
  (encode-coding-string (json-serialize object) 'utf-8))

(defun doc-review--multipart (boundary fields)
  "Build a multipart/form-data body (unibyte) with BOUNDARY.
FIELDS is a list of (NAME . STRING), (NAME :file PATH :type MIME) or
\(NAME :data STRING :filename NAME :type MIME)."
  (with-temp-buffer
    (set-buffer-multibyte nil)
    (dolist (f fields)
      (insert "--" boundary "\r\n")
      (cond
       ((and (consp (cdr f)) (memq (cadr f) '(:file :data)))
        (let* ((plist (cdr f))
               (path (plist-get plist :file))
               (name (or (plist-get plist :filename) (file-name-nondirectory path))))
          (insert (format "Content-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                          (car f) (encode-coding-string name 'utf-8))
                  "Content-Type: " (plist-get plist :type) "\r\n\r\n")
          (goto-char (point-max))
          (if path
              (insert-file-contents-literally path)
            (insert (encode-coding-string (plist-get plist :data) 'utf-8)))))
       (t
        (insert (format "Content-Disposition: form-data; name=\"%s\"\r\n\r\n" (car f))
                (encode-coding-string (cdr f) 'utf-8))))
      (goto-char (point-max))
      (insert "\r\n"))
    (insert "--" boundary "--\r\n")
    (buffer-string)))

(defun doc-review--doc-path (project &rest parts)
  "API path of PROJECT's document followed by PARTS."
  (concat "/api/documents/" (url-hexify-string (doc-review--document project))
          (apply #'concat parts)))

;;; Sources

(defun doc-review--glob-regexp (glob)
  "Regexp matching relative paths against GLOB.
`**/' is any number of directories; `*' and `?' stay within one."
  (let ((i 0) (out "\\`") (n (length glob)))
    (while (< i n)
      (let ((c (aref glob i)))
        (cond
         ((and (eq c ?*) (< (1+ i) n) (eq (aref glob (1+ i)) ?*))
          (if (and (< (+ i 2) n) (eq (aref glob (+ i 2)) ?/))
              (setq out (concat out "\\(?:.*/\\)?") i (+ i 3))
            (setq out (concat out ".*") i (+ i 2))))
         ((eq c ?*) (setq out (concat out "[^/]*") i (1+ i)))
         ((eq c ??) (setq out (concat out "[^/]") i (1+ i)))
         (t (setq out (concat out (regexp-quote (string c))) i (1+ i))))))
    (concat out "\\'")))

(defun doc-review--source-files (project)
  "Source files of PROJECT: its \"sources\" globs, or `doc-review-default-sources'.
Hidden and build directories are skipped."
  (let* ((root (doc-review-project-root project))
         (globs (or (doc-review-project-sources project) doc-review-default-sources))
         (res (mapcar #'doc-review--glob-regexp globs))
         (files (directory-files-recursively
                 root "" nil
                 (lambda (dir) (not (string-match-p "/\\.[^/]*\\'\\|/node_modules\\'\\|/ltximg\\'\\|/_minted" dir))))))
    (sort (cl-remove-if-not
           (lambda (f)
             (let ((rel (file-relative-name f root)))
               (and (not (string-match-p "\\`\\.\\|/\\." rel))
                    (cl-some (lambda (re) (string-match-p re rel)) res))))
           files)
          #'string<)))

(defun doc-review--source-p (project file)
  "Non-nil if FILE is one of PROJECT's sources."
  (let ((rel (file-relative-name (expand-file-name file) (doc-review-project-root project))))
    (and (not (string-prefix-p ".." rel))
         (cl-some (lambda (g) (string-match-p (doc-review--glob-regexp g) rel))
                  (or (doc-review-project-sources project) doc-review-default-sources)))))

;;; Publishing

(defun doc-review--progress-part (project)
  "The progress part of a publication for PROJECT, or nil.
\"progress\" is a file, a shell command printing the JSON, or
{\"command\": …, \"file\": …} (run the command, then send the file)."
  (let* ((root (doc-review-project-root project))
         (default-directory root)
         (p (doc-review-project-progress project))
         (run (lambda (cmd)
                (with-temp-buffer
                  (let ((status (call-process-shell-command cmd nil (list t nil) nil)))
                    (unless (eq status 0) (user-error (doc-review--t 'command-failed cmd status)))
                    (buffer-string))))))
    (cond
     ((null p) nil)
     ((stringp p)
      (let ((file (expand-file-name p root)))
        (if (file-readable-p file)
            `("progress" :file ,file :type "application/json")
          `("progress" :data ,(funcall run p) :filename "progress.json" :type "application/json"))))
     ((consp p)
      (let ((cmd (alist-get 'command p)) (file (alist-get 'file p)))
        (when (stringp cmd) (funcall run cmd))
        (when (stringp file)
          (let ((path (expand-file-name file root)))
            (unless (file-readable-p path) (user-error (doc-review--t 'no-progress path)))
            `("progress" :file ,path :type "application/json"))))))))

(defun doc-review--newest-source-mtime (project)
  "Modification time of PROJECT's newest source file."
  (let (newest)
    (dolist (f (doc-review--source-files project) newest)
      (let ((m (file-attribute-modification-time (file-attributes f))))
        (when (or (null newest) (time-less-p newest m)) (setq newest m))))))

;;; Choosing the PDF

(defvar doc-review-note-history nil
  "Previous version notes (`doc-review-publish').")

(defvar doc-review-pdf-history nil
  "PDFs chosen with \[universal-argument] \[doc-review-publish].")

(defun doc-review--newest-first (files)
  "Existing regular FILES, the most recently modified first, without duplicates."
  (let ((files (cl-remove-duplicates
                (cl-remove-if-not #'file-regular-p (mapcar #'expand-file-name files))
                :test #'equal)))
    (sort files (lambda (a b)
                  (time-less-p (file-attribute-modification-time (file-attributes b))
                               (file-attribute-modification-time (file-attributes a)))))))

(defun doc-review--project-pdf (project)
  "The PDF to publish by default for PROJECT, or nil.
\"pdf\" is a file or a list of files and globs (`*', `?' and `[…]' in
names, as `file-expand-wildcards'): the most recently modified existing
match wins.  A single plain file is returned even if it doesn't exist
yet, so the caller can say it must be built."
  (let* ((root (doc-review-project-root project))
         (patterns (doc-review-project-pdf project))
         (default-directory root))
    (if (and (= (length patterns) 1) (not (string-match-p "[*?[]" (car patterns))))
        (expand-file-name (car patterns) root)
      (car (doc-review--newest-first
            (mapcan (lambda (p)
                      (if (string-match-p "[*?[]" p)
                          (file-expand-wildcards p t)
                        (list (expand-file-name p root))))
                    patterns))))))

(defun doc-review--pdf-candidates (project)
  "PDFs to offer for PROJECT, the default first.
The result of `tesis-pcc-ultimo-pdf' when that function exists, then the
PDFs of the project's root and the \"pdf\" of .doc-review.json, the most
recently modified first."
  (let* ((root (doc-review-project-root project))
         (helper (and (fboundp 'tesis-pcc-ultimo-pdf)
                      (ignore-errors
                        (let ((default-directory root)) (funcall 'tesis-pcc-ultimo-pdf)))))
         (helper (and (stringp helper) (expand-file-name helper root)))
         (configured (ignore-errors (doc-review--project-pdf project))))
    (cl-remove-duplicates
     (append (and helper (file-regular-p helper) (list helper))
             (doc-review--newest-first
              (append (directory-files root t "\\.[pP][dD][fF]\\'" t)
                      (and configured (list configured)))))
     :test #'equal :from-end t)))

(defun doc-review--read-pdf (project)
  "Ask for the PDF to publish for PROJECT (default: the first candidate)."
  (let* ((root (doc-review-project-root project))
         (candidates (doc-review--pdf-candidates project))
         (file (read-file-name (doc-review--t 'pdf-prompt) root candidates t
                               (and (car candidates) (file-relative-name (car candidates) root))
                               (lambda (f) (or (file-directory-p f) (string-match-p "\\.[pP][dD][fF]\\'" f))))))
    (expand-file-name file root)))

(defun doc-review--note-suggestion (pdf)
  "A note to offer with M-n for PDF: the first line of FILE.note next to it."
  (let ((sidecar (concat (file-name-sans-extension pdf) ".note")))
    (when (file-readable-p sidecar)
      (with-temp-buffer
        (insert-file-contents sidecar)
        (let ((first (doc-review--clean-line
                      (buffer-substring-no-properties (point-min) (line-end-position)))))
          (and (> (length first) 0) first))))))

(defun doc-review--read-note (pdf)
  "Ask for the version note of PDF: empty by default, with history.
M-n offers the PDF's sidecar note (FILE.note), when there is one."
  (read-from-minibuffer (doc-review--t 'note-prompt (file-name-nondirectory pdf))
                        nil nil nil 'doc-review-note-history
                        (doc-review--note-suggestion pdf)))

(defun doc-review--default-pdf (project)
  "PROJECT's PDF from .doc-review.json, or a `user-error'."
  (let ((file (expand-file-name doc-review-project-file (doc-review-project-root project))))
    (unless (doc-review-project-pdf project)
      (user-error (doc-review--t 'no-pdf-setting file)))
    (or (doc-review--project-pdf project)
        (user-error (doc-review--t 'no-pdf-match file
                                   (string-join (doc-review-project-pdf project) ", "))))))

;;;###autoload
(defun doc-review-publish (note &optional pdf)
  "Upload a PDF (and the progress) as a new version with NOTE.
The PDF is PDF, or the \"pdf\" of .doc-review.json (the newest match when
it is a list or has globs).  Interactively, with \[universal-argument],
ask for the file: the default is `tesis-pcc-ultimo-pdf' (when defined),
else the most recently modified PDF of the project's root."
  (interactive
   (let* ((project (doc-review--project))
          (pdf (if current-prefix-arg
                   (doc-review--read-pdf project)
                 (doc-review--default-pdf project))))
     (list (doc-review--read-note pdf) pdf)))
  (let* ((project (doc-review--project))
         (pdf (progn (doc-review--document project)
                     (or pdf (doc-review--default-pdf project)))))
    (unless (file-readable-p pdf) (user-error (doc-review--t 'no-pdf pdf)))
    (let ((newest (doc-review--newest-source-mtime project))
          (pdf-time (file-attribute-modification-time (file-attributes pdf))))
      (when (and newest (time-less-p pdf-time newest)
                 (called-interactively-p 'interactive)
                 (not (y-or-n-p (doc-review--t 'pdf-older (file-name-nondirectory pdf)))))
        (user-error (doc-review--t 'cancelled))))
    (message "%s" (doc-review--t 'publishing (file-name-nondirectory pdf)))
    (let* ((progress (doc-review--progress-part project))
           (boundary (format "doc-review-%s" (md5 (format "%s%s" (random) (float-time)))))
           (body (doc-review--multipart
                  boundary
                  (delq nil `(("pdf" :file ,pdf :type "application/pdf")
                              ,progress
                              ("note" . ,note)))))
           (r (doc-review--request project "POST" (doc-review--doc-path project "/versions") body
                                   (concat "multipart/form-data; boundary=" boundary)))
           (v (alist-get 'version r)))
      (message "%s" (doc-review--t 'published (alist-get 'number v) (alist-get 'page_count v)
                                   (doc-review--clean-line (alist-get 'url r))))
      r)))

;;; Normalization and anchoring

(defun doc-review--word-char-p (c)
  "Non-nil if C is a letter or a digit."
  (memq (get-char-code-property c 'general-category) '(Lu Ll Lt Lm Lo Nd)))

(defun doc-review--normalize-quote (quote)
  "Reduce a PDF QUOTE to lowercase letters and digits.
Ligatures and compatibility characters are unfolded (NFKC); citation marks
such as [3] or [1, 4–6] are removed (the sources have citation keys instead)."
  (let* ((s (ucs-normalize-NFKC-string quote))
         (s (replace-regexp-in-string "\u00ad" "" s))
         (s (replace-regexp-in-string "\\[[0-9][0-9,;–— -]*\\]" " " s)))
    (apply #'string (cl-loop for c across (downcase s)
                             when (doc-review--word-char-p c) collect c))))

(defconst doc-review--mask-regexps
  '((org
     ;; Blocks whose text isn't in the PDF.
     ("^[ \t]*#\\+begin_\\(comment\\|src\\|example\\)\\(?:.\\|\n\\)*?\n[ \t]*#\\+end_\\1.*$" . 0)
     ;; Drawers (:PROPERTIES: … :END:) and their lines.
     ("^[ \t]*:[A-Za-z_-]+:.*$" . 0)
     ;; Comments and keywords (#+TITLE, #+LATEX, #+INCLUDE …).
     ("^[ \t]*#\\(?:[ +].*\\)?$" . 0)
     ;; Citations.
     ("\\[cite[^]]*\\]" . 0)
     ;; Link targets: [[target][ and [[target]] (descriptions are kept).
     ("\\[\\[[^]]*\\]\\[" . 0) ("\\[\\[[^]]*\\]\\]" . 0)
     ;; LaTeX commands (the arguments stay: \\gls{LLM} → LLM).
     ("\\\\[a-zA-Z]+\\*?" . 0)
     ;; Headline tags.
     ("[ \t]+:[[:alnum:]_@#%:]+:[ \t]*$" . 0))
    (tex
     ;; Comments: from an unescaped % to the end of the line.
     ("\\(?:^\\|[^\\\\]\\)\\(%.*\\)$" . 1)
     ;; Commands whose argument isn't text: citations, labels, references, files.
     ("\\\\\\(?:[a-zA-Z]*cite[a-zA-Z]*\\|label\\|[a-zA-Z]*ref\\|input\\|includegraphics\\|include\\|bibliography\\|bibliographystyle\\|usepackage\\|documentclass\\|begin\\|end\\|url\\)\\*?\\(?:\\[[^]]*\\]\\)*\\(?:{[^}]*}\\)?" . 0)
     ;; Other commands (the arguments stay: \\emph{text} → text).
     ("\\\\[a-zA-Z]+\\*?" . 0))
    (md
     ;; Front matter, HTML comments and code fences.
     ("\\`---\n\\(?:.\\|\n\\)*?\n---$" . 0)
     ("<!--\\(?:.\\|\n\\)*?-->" . 0)
     ("^[ \t]*```\\(?:.\\|\n\\)*?\n[ \t]*```.*$" . 0)
     ;; Link and image targets (the text stays), reference definitions.
     ("\\](\\([^)]*\\))" . 1)
     ("^[ \t]*\\[[^]]+\\]:.*$" . 0)
     ;; Pandoc citations and inline HTML tags.
     ("\\[-?@[^]]*\\]" . 0)
     ("</?[a-zA-Z][^>]*>" . 0)))
  "By source format: (REGEXP . GROUP) regions replaced by spaces before matching.")

(defun doc-review--format (file)
  "Source format of FILE: org, tex or md."
  (let ((ext (downcase (or (file-name-extension (or file "")) ""))))
    (cond ((member ext '("tex" "ltx" "sty" "cls")) 'tex)
          ((member ext '("md" "markdown" "mdx" "qmd" "rmd")) 'md)
          (t 'org))))

(defun doc-review--index-string (text &optional format)
  "Index TEXT (a source of FORMAT, default org): return (NORMALIZED . POSITIONS).
NORMALIZED has only lowercase letters and digits; POSITIONS maps each of its
characters to a 1-based offset in TEXT."
  (let ((masked (with-temp-buffer
                  (insert text)
                  (dolist (m (alist-get (or format 'org) doc-review--mask-regexps))
                    (goto-char (point-min))
                    (while (re-search-forward (car m) nil t)
                      (let ((b (match-beginning (cdr m))) (e (match-end (cdr m))))
                        (if (or (null b) (= b e))
                            (when (= (match-beginning 0) (match-end 0))
                              (unless (eobp) (forward-char 1)))
                          ;; Spaces instead, keeping newlines and the length.
                          (let ((s (buffer-substring b e)))
                            (save-excursion
                              (goto-char b)
                              (delete-region b e)
                              (insert (replace-regexp-in-string "[^\n]" " " s))))))))
                  (buffer-string)))
        (chars nil) (pos nil) (i 0))
    (dolist (c (append masked nil))
      (setq i (1+ i))
      (when (doc-review--word-char-p c)
        (push (downcase c) chars)
        (push i pos)))
    (cons (apply #'string (nreverse chars)) (vconcat (nreverse pos)))))

(defvar doc-review--index-cache (make-hash-table :test #'equal)
  "File name → (MTIME . INDEX) of the sources.")

(defun doc-review--file-index (file)
  "Index of FILE: from its live buffer if modified, else cached by mtime."
  (let ((buf (get-file-buffer file))
        (format (doc-review--format file)))
    (if (and buf (buffer-modified-p buf))
        (with-current-buffer buf
          (doc-review--index-string (buffer-substring-no-properties (point-min) (point-max)) format))
      (let* ((mtime (file-attribute-modification-time (file-attributes file)))
             (hit (gethash file doc-review--index-cache)))
        (if (and hit (equal (car hit) mtime))
            (cdr hit)
          (let ((idx (doc-review--index-string
                      (with-temp-buffer (insert-file-contents file) (buffer-string)) format)))
            (puthash file (cons mtime idx) doc-review--index-cache)
            idx))))))

(defun doc-review--locate-in-index (q index)
  "Find normalized quote Q in INDEX; return (START . END) offsets or nil.
Exact match first.  Otherwise Q is cut in 12-character pieces and the place
of the source where most pieces fall together wins: that survives edits made
after the PDF was built and text the PDF expands (\\gls{LLM} → \"large
language model (LLM)\")."
  (let ((text (car index)) (pos (cdr index)) (n (length q)))
    (when (>= n doc-review-min-quote-length)
      (let ((i (string-search q text)))
        (if i
            (cons (aref pos i) (1+ (aref pos (+ i n -1))))
          (doc-review--locate-pieces q text pos))))))

(defun doc-review--locate-pieces (q text pos)
  "Fuzzy match of Q in TEXT (POS maps offsets).
See `doc-review--locate-in-index'."
  (let* ((k 12) (n (length q)) (pieces (/ n k)) (hits nil))
    (when (>= pieces 2)
      (dotimes (p pieces)
        (let ((piece (substring q (* p k) (* (1+ p) k))) (from 0) (count 0) found)
          (while (and (< count 20) (setq found (string-search piece text from)))
            ;; (estimated start of the quote, piece start, piece end)
            (push (list (- found (* p k)) found
                        ;; The last piece also covers the remainder of Q.
                        (min (length text) (+ found k (if (= p (1- pieces)) (- n (* pieces k)) 0))))
                  hits)
            (setq from (1+ found) count (1+ count)))))
      (setq hits (sort hits (lambda (a b) (< (car a) (car b)))))
      ;; Sliding window over the estimated starts: the densest cluster wins.
      (let ((window (+ (/ n 2) 40)) (best nil) (best-count 0) (tail hits))
        (while tail
          (let* ((start (car (car tail)))
                 (members (cl-loop for h in tail while (<= (car h) (+ start window)) collect h))
                 (count (length (cl-remove-duplicates members :key (lambda (h) (- (nth 1 h) (car h)))))))
            (when (> count best-count) (setq best members best-count count)))
          (setq tail (cdr tail)))
        (when (and best (>= best-count (max 2 (ceiling (* 0.4 pieces)))))
          (let ((b (apply #'min (mapcar #'cadr best)))
                (e (apply #'max (mapcar #'caddr best))))
            (cons (aref pos b) (1+ (aref pos (1- e))))))))))

(defun doc-review--locate (thread files)
  "Locate THREAD's quote in FILES: return (FILE START END) or nil.
The file named after the thread's section id is tried first."
  (let* ((q (doc-review--normalize-quote (or (alist-get 'quote thread) "")))
         (section (alist-get 'id (alist-get 'section thread)))
         (same (lambda (f) (equal (file-name-base f) section)))
         (ordered (if section
                      (append (cl-remove-if-not same files) (cl-remove-if same files))
                    files)))
    (cl-loop for f in ordered
             for hit = (doc-review--locate-in-index q (doc-review--file-index f))
             when hit return (list f (car hit) (cdr hit)))))

(defun doc-review--line-at (file offset)
  "Line number of 1-based character OFFSET in FILE."
  (with-temp-buffer
    (insert-file-contents file)
    (line-number-at-pos (min offset (point-max)))))

;;; Threads cache (per project)

(defvar doc-review--cache (make-hash-table :test #'equal)
  "Project root → open threads of its document, from the last fetch.")

(defun doc-review--fetch-threads (project &optional all)
  "Fetch the open threads (all with ALL) of PROJECT's document.
Newest version first."
  (let ((threads (alist-get 'threads
                            (doc-review--request project "GET"
                                                 (doc-review--doc-path project "/threads?status=" (if all "all" "open"))))))
    (unless all (puthash (doc-review-project-root project) threads doc-review--cache))
    threads))

(defun doc-review--cached-threads (project)
  "PROJECT's cached open threads, or :none if not fetched yet."
  (gethash (doc-review-project-root project) doc-review--cache :none))

;;; The comments buffer

(defvar-local doc-review--buffer-project nil
  "Project of a comments buffer.")

(defvar-local doc-review--buffer-all nil
  "Non-nil if the comments buffer shows resolved threads too.")

(defun doc-review--date (iso)
  "Short local date of ISO."
  (if (and iso (fboundp 'iso8601-parse))
      (condition-case nil
          (format-time-string "%Y-%m-%d %H:%M" (encode-time (iso8601-parse iso)))
        (error iso))
    (or iso "")))

(defun doc-review--who (author)
  "AUTHOR's name and role, for one line."
  (let ((name (doc-review--clean-line (alist-get 'name author)))
        (role (doc-review--clean-line (alist-get 'role author))))
    (if (string-empty-p role) name (format "%s (%s)" name role))))

(defun doc-review--insert-thread (thread loc project)
  "Insert THREAD (located at LOC in PROJECT's sources) as an org subtree."
  (let* ((root (doc-review-project-root project))
         (comments (alist-get 'comments thread)))
    (insert (format "** p. %s · v%s · %s%s\n"
                    (alist-get 'page thread)
                    (alist-get 'version thread)
                    (doc-review--who (alist-get 'author thread))
                    (if (equal (alist-get 'status thread) "resolved")
                        (concat " · " (doc-review--t 'resolved-tag)) "")))
    (insert ":PROPERTIES:\n"
            (format ":DOC_REVIEW_ID: %s\n" (alist-get 'id thread))
            (format ":DOC_REVIEW_URL: %s\n" (doc-review--clean-line (alist-get 'url thread)))
            ":END:\n")
    (if loc
        (let ((rel (file-relative-name (nth 0 loc) root))
              (line (doc-review--line-at (nth 0 loc) (nth 1 loc))))
          (insert (format "%s: [[file:%s::%d][%s:%d]]\n" (doc-review--t 'source) (nth 0 loc) line rel line)))
      ;; Not anchored (a point comment, or text that changed): link the section's file.
      (let* ((section (alist-get 'id (alist-get 'section thread)))
             (file (and section (cl-find section (doc-review--source-files project)
                                         :key #'file-name-base :test #'equal))))
        (when file
          (insert (format "%s: [[file:%s][%s]]\n" (doc-review--t 'section-file) file (file-relative-name file root))))))
    (insert (format "%s: [[%s][%s]]\n" (doc-review--t 'web)
                    (doc-review--clean-line (alist-get 'url thread)) (doc-review--t 'open-in-pdf)))
    (unless (string-empty-p (or (alist-get 'quote thread) ""))
      (insert (doc-review--t 'quote) ":\n" (doc-review--literal (alist-get 'quote thread) "  ") "\n"))
    (dolist (c comments)
      (insert (format "- %s, %s%s:\n"
                      (doc-review--who (alist-get 'author c))
                      (doc-review--clean-line (doc-review--date (alist-get 'created_at c)))
                      (if (alist-get 'edited_at c) (doc-review--t 'edited) ""))
              (if (eq (alist-get 'deleted c) t)
                  (concat "  : " (doc-review--t 'deleted))
                (doc-review--literal (alist-get 'body c) "  "))
              "\n"))
    (insert "\n")))

(defun doc-review--render (threads project title)
  "Insert THREADS of PROJECT's document TITLE, grouped by section and anchored."
  (let* ((files (doc-review--source-files project))
         (located (mapcar (lambda (th) (cons th (and files (doc-review--locate th files)))) threads))
         (anchored (cl-remove-if-not #'cdr located))
         (unanchored (cl-remove-if #'cdr located))
         (open (cl-count-if (lambda (th) (equal (alist-get 'status th) "open")) threads))
         (groups nil))
    (dolist (pair anchored)
      (let ((key (or (alist-get 'title (alist-get 'section (car pair))) (doc-review--t 'no-section))))
        (push pair (alist-get key groups nil nil #'equal))))
    (insert "#+TITLE: " (doc-review--clean-line (doc-review--t 'buffer-title title)) "\n#+STARTUP: content\n\n"
            (if (= open (length threads))
                (doc-review--t 'buffer-count-open open)
              (doc-review--t 'buffer-count open (length threads)))
            "\n" (doc-review--t 'buffer-keys) "\n\n")
    (dolist (g (nreverse groups))
      (insert (format "* %s\n" (doc-review--clean-line (car g))))
      (dolist (pair (sort (nreverse (cdr g))
                          (lambda (a b) (< (alist-get 'page (car a)) (alist-get 'page (car b))))))
        (doc-review--insert-thread (car pair) (cdr pair) project)))
    (when unanchored
      (insert (format "* %s\n" (doc-review--t 'unanchored)))
      (dolist (pair unanchored)
        (doc-review--insert-thread (car pair) nil project)))))

(defvar doc-review-comments-mode-map
  (let ((m (make-sparse-keymap)))
    (define-key m (kbd "RET") #'doc-review-visit-source)
    (define-key m (kbd "o") #'doc-review-open-in-browser)
    (define-key m (kbd "r") #'doc-review-reply)
    (define-key m (kbd "x") #'doc-review-resolve)
    (define-key m (kbd "X") #'doc-review-reopen)
    (define-key m (kbd "g") #'doc-review-refresh)
    (define-key m (kbd "n") #'doc-review-next-thread)
    (define-key m (kbd "p") #'doc-review-previous-thread)
    (define-key m (kbd "q") #'quit-window)
    m)
  "Keys of the comments buffer (without evil).")

(defconst doc-review--evil-keys
  '(("RET" . doc-review-visit-source)
    ("<return>" . doc-review-visit-source)
    ("o" . doc-review-open-in-browser)
    ("r" . doc-review-reply)
    ("x" . doc-review-resolve)
    ("X" . doc-review-reopen)
    ("gr" . doc-review-refresh)
    ("]]" . doc-review-next-thread)
    ("[[" . doc-review-previous-thread)
    ("q" . quit-window))
  "Keys of the comments buffer in evil's normal and motion states.")

(defun doc-review--setup-evil ()
  "Bind `doc-review--evil-keys' in this buffer's evil normal and motion states.
Buffer-local state maps take precedence over minor modes' maps (evil-org),
so evil's normal state can't shadow them."
  (when (fboundp 'evil-local-set-key)
    (dolist (state '(normal motion))
      (dolist (k doc-review--evil-keys)
        (evil-local-set-key state (kbd (car k)) (cdr k))))))

(define-derived-mode doc-review-comments-mode org-mode "Doc-Review"
  "Read-only org buffer with a document's review threads.
\\{doc-review-comments-mode-map}
With evil: RET, o, r, x, X and q as above; gr refreshes; ]] and [[ move
between threads."
  (setq buffer-read-only t)
  (setq-local truncate-lines nil))

(add-hook 'doc-review-comments-mode-hook #'doc-review--setup-evil 90)

(with-eval-after-load 'evil
  (when (fboundp 'evil-define-key*)
    (dolist (k doc-review--evil-keys)
      (evil-define-key* '(normal motion) doc-review-comments-mode-map (kbd (car k)) (cdr k)))))

(defun doc-review--buffer-name (project)
  "Name of the comments buffer of PROJECT."
  (format "*doc-review: %s*" (doc-review--document project)))

(defun doc-review--current-project (&optional noerror)
  "The project of the current buffer (comments buffers remember theirs)."
  (or doc-review--buffer-project (doc-review--project nil noerror)))

;;;###autoload
(defun doc-review-comments (&optional all)
  "Show the open comments (all with prefix ALL) of the project's document."
  (interactive "P")
  (let* ((project (doc-review--current-project))
         (threads (doc-review--fetch-threads project all))
         (name (doc-review--buffer-name project)))
    (with-current-buffer (get-buffer-create name)
      (let ((inhibit-read-only t))
        (erase-buffer)
        (doc-review-comments-mode)
        (setq doc-review--buffer-project project
              doc-review--buffer-all all
              default-directory (doc-review-project-root project))
        (doc-review--render threads project (doc-review--document project))
        (goto-char (point-min))
        (set-buffer-modified-p nil)))
    (doc-review--refresh-flymake)
    (unless noninteractive (pop-to-buffer name))
    threads))

(defun doc-review-next-thread ()
  "Move to the next thread."
  (interactive)
  (end-of-line)
  (if (re-search-forward "^\\*\\* " nil t) (beginning-of-line) (goto-char (point-max))))

(defun doc-review-previous-thread ()
  "Move to the previous thread."
  (interactive)
  (beginning-of-line)
  (when (re-search-backward "^\\*\\* " nil t) (beginning-of-line)))

(defun doc-review-visit-source ()
  "Open the source of the thread at point (or its section's file)."
  (interactive)
  (save-excursion
    (unless (org-at-heading-p) (org-back-to-heading t))
    (let ((end (save-excursion (org-end-of-subtree t t)))
          (re (format "^\\(?:%s\\|%s\\): \\[\\[file:"
                      (regexp-quote (doc-review--t 'source)) (regexp-quote (doc-review--t 'section-file)))))
      (if (re-search-forward re end t)
          (progn (backward-char 7) (org-open-at-point))
        (user-error (doc-review--t 'no-source-here))))))

;;; Thread at point, reply, resolve

(defun doc-review--thread-at-point (&optional project)
  "Thread id at point: comments buffer heading, Flymake note, or a prompt."
  (or (when (derived-mode-p 'org-mode)
        (let ((id (ignore-errors (org-entry-get nil "DOC_REVIEW_ID" t))))
          (and id (string-to-number id))))
      (cl-loop for d in (flymake-diagnostics (point))
               when (eq (flymake-diagnostic-backend d) #'doc-review-flymake)
               return (flymake-diagnostic-data d))
      (let* ((project (or project (doc-review--current-project)))
             (cached (doc-review--cached-threads project))
             (threads (if (eq cached :none) (doc-review--fetch-threads project) cached))
             (choices (mapcar (lambda (th)
                                (cons (format "#%s p. %s · %s: %s"
                                              (alist-get 'id th) (alist-get 'page th)
                                              (doc-review--who (alist-get 'author th))
                                              (truncate-string-to-width
                                               (doc-review--clean-line
                                                (alist-get 'body (car (alist-get 'comments th))))
                                               60))
                                      (alist-get 'id th)))
                              threads)))
        (unless choices (user-error (doc-review--t 'no-open-threads)))
        (cdr (assoc (completing-read (doc-review--t 'thread-prompt) choices nil t) choices)))))

;;;###autoload
(defun doc-review-reply (id text)
  "Reply TEXT to thread ID (the one at point by default)."
  (interactive (let ((id (doc-review--thread-at-point)))
                 (list id (read-string (doc-review--t 'reply-prompt id)))))
  (when (string-empty-p (string-trim text)) (user-error (doc-review--t 'empty-reply)))
  (doc-review--request (doc-review--current-project) "POST" (format "/api/threads/%d/comments" id)
                       (doc-review--json-body `((body . ,text))) "application/json")
  (message "%s" (doc-review--t 'replied id))
  (doc-review--after-change))

;;;###autoload
(defun doc-review-resolve (id &optional reopen)
  "Mark thread ID resolved; with prefix REOPEN, reopen it."
  (interactive (list (doc-review--thread-at-point) current-prefix-arg))
  (doc-review--request (doc-review--current-project) "POST"
                       (format "/api/threads/%d/%s" id (if reopen "reopen" "resolve")))
  (message "%s" (doc-review--t (if reopen 'reopened 'resolved) id))
  (doc-review--after-change))

;;;###autoload
(defun doc-review-reopen (id)
  "Reopen thread ID (the one at point by default)."
  (interactive (list (doc-review--thread-at-point)))
  (doc-review-resolve id t))

(defun doc-review--after-change ()
  "Refresh the comments buffer if it exists, else the Flymake notes."
  (let* ((project (doc-review--current-project))
         (buf (get-buffer (doc-review--buffer-name project))))
    (if buf
        (with-current-buffer buf (doc-review-comments doc-review--buffer-all))
      (doc-review--fetch-threads project)
      (doc-review--refresh-flymake))))

;;;###autoload
(defun doc-review-refresh ()
  "Fetch the comments again: the comments buffer and the Flymake notes."
  (interactive)
  (let ((project (doc-review--current-project)))
    (if (derived-mode-p 'doc-review-comments-mode)
        (doc-review-comments doc-review--buffer-all)
      (let ((threads (doc-review--fetch-threads project)))
        (let ((buf (get-buffer (doc-review--buffer-name project))))
          (when buf (with-current-buffer buf (doc-review-comments doc-review--buffer-all))))
        (doc-review--refresh-flymake)
        (message "%s" (doc-review--t 'fetched (length threads)))))))

;;; Browser and documents

;;;###autoload
(defun doc-review-open-in-browser (&optional manage)
  "Open the thread at point, or the document, in the browser.
With prefix MANAGE, the document's management page."
  (interactive "P")
  (let* ((project (doc-review--current-project))
         (thread-url (and (not manage) (derived-mode-p 'org-mode)
                          (ignore-errors (org-entry-get nil "DOC_REVIEW_URL" t))))
         (url (if (and thread-url (string-match-p "\\`https?://" thread-url))
                  thread-url
                (concat (car (doc-review--server project)) "/d/"
                        (url-hexify-string (doc-review--document project))
                        (if manage "/manage" "")))))
    (browse-url url)
    url))

(defvar-local doc-review--documents-project nil
  "Project (server) of a documents list buffer.")

(defun doc-review--documents-entries (documents)
  "Tabulated-list entries for DOCUMENTS."
  (mapcar (lambda (d)
            (let ((latest (alist-get 'latest_version d)))
              (list (alist-get 'slug d)
                    (vector (doc-review--clean-line (alist-get 'slug d))
                            (doc-review--clean-line (alist-get 'title d))
                            (doc-review--clean-line (alist-get 'language d))
                            (if latest (format "v%s" (alist-get 'number latest)) "-")
                            (format "%s" (or (alist-get 'open_threads d) ""))
                            (doc-review--t (if (eq (alist-get 'archived d) t) 'archived 'active))))))
          documents))

(defvar doc-review-documents-mode-map
  (let ((m (make-sparse-keymap)))
    (define-key m (kbd "RET") #'doc-review-documents-open)
    (define-key m (kbd "o") #'doc-review-documents-open)
    m)
  "Keys of the documents list.")

(define-derived-mode doc-review-documents-mode tabulated-list-mode "Doc-Review-Documents"
  "Your documents on the doc-review server.
RET or o: open in the browser; g: refresh."
  (add-hook 'tabulated-list-revert-hook #'doc-review--documents-revert nil t))

(defun doc-review--documents-revert ()
  "Fetch the documents list again."
  (setq tabulated-list-entries
        (doc-review--documents-entries
         (alist-get 'documents (doc-review--request doc-review--documents-project "GET" "/api/documents")))))

(defun doc-review-documents-open ()
  "Open the document at point in the browser."
  (interactive)
  (let ((slug (tabulated-list-get-id)))
    (unless slug (user-error (doc-review--t 'no-document-here)))
    (browse-url (concat (car (doc-review--server doc-review--documents-project)) "/d/" (url-hexify-string slug)))))

;;;###autoload
(defun doc-review-list-documents ()
  "List your documents on the server (of this project, or the configured one)."
  (interactive)
  (let* ((project (doc-review--current-project t))
         (docs (alist-get 'documents (doc-review--request project "GET" "/api/documents"))))
    (with-current-buffer (get-buffer-create "*doc-review documents*")
      (doc-review-documents-mode)
      (setq doc-review--documents-project project
            tabulated-list-format
            (vector (list (doc-review--t 'col-document) 18 t)
                    (list (doc-review--t 'col-title) 40 t)
                    (list (doc-review--t 'col-role) 8 t)
                    (list (doc-review--t 'col-latest) 7 t)
                    (list (doc-review--t 'col-open) 8 t)
                    (list (doc-review--t 'col-state) 10 t))
            tabulated-list-entries (doc-review--documents-entries docs))
      (tabulated-list-init-header)
      (tabulated-list-print)
      (unless noninteractive (pop-to-buffer (current-buffer)))
      docs)))

;;; Flymake

(defun doc-review--diagnostic-text (thread)
  "One-line summary of THREAD for Flymake."
  (let* ((cs (alist-get 'comments thread))
         (last (car (last (cl-remove-if (lambda (c) (eq (alist-get 'deleted c) t)) cs)))))
    (format "%s (v%s p. %s%s): %s"
            (doc-review--who (alist-get 'author (car cs)))
            (alist-get 'version thread) (alist-get 'page thread)
            (if (> (length cs) 1) (doc-review--t 'diag-messages (length cs)) "")
            (replace-regexp-in-string "[\n\t]+" " " (doc-review--sanitize (alist-get 'body last))))))

(defun doc-review--buffer-diagnostics (threads)
  "Flymake diagnostics for THREADS anchored in the current buffer."
  (let ((index (doc-review--index-string
                (buffer-substring-no-properties (point-min) (point-max))
                (doc-review--format (or buffer-file-name (buffer-name)))))
        diags)
    (dolist (th threads (nreverse diags))
      (let* ((q (doc-review--normalize-quote (or (alist-get 'quote th) "")))
             (hit (doc-review--locate-in-index q index)))
        (when hit
          (push (flymake-make-diagnostic
                 (current-buffer)
                 (+ (point-min) (1- (car hit))) (+ (point-min) (1- (cdr hit)))
                 :note (doc-review--diagnostic-text th) (alist-get 'id th))
                diags))))))

(defvar-local doc-review--mode-project nil
  "Project of a buffer with `doc-review-mode'.")

(defun doc-review-flymake (report-fn &rest _)
  "Flymake backend: open review comments as notes on the matching text.
REPORT-FN is Flymake's callback."
  (let* ((project doc-review--mode-project)
         (cached (and project (doc-review--cached-threads project))))
    (funcall report-fn
             (if (and project (not (eq cached :none)))
                 (doc-review--buffer-diagnostics cached)
               (when project (doc-review--fetch-async project))
               nil))))

(defvar doc-review--fetching nil
  "Project roots being fetched in the background.")

(defun doc-review--fetch-async (project)
  "Fetch PROJECT's open threads in the background, then rerun Flymake."
  (let ((root (doc-review-project-root project)))
    (unless (or (member root doc-review--fetching) noninteractive)
      (let ((server (ignore-errors (doc-review--server project)))
            (slug (doc-review-project-document project)))
        (when (and server slug)
          (push root doc-review--fetching)
          (let ((url-request-method "GET")
                (url-request-extra-headers (doc-review--headers (cdr server))))
            (url-retrieve
             (concat (car server) (doc-review--doc-path project "/threads?status=open"))
             (lambda (status)
               (unwind-protect (doc-review--fetch-async-done project status)
                 (kill-buffer (current-buffer))))
             nil t t)))))))

(defun doc-review--fetch-async-done (project status)
  "Handle the response of `doc-review--fetch-async' for PROJECT (current buffer).
STATUS is url.el's status plist.  Errors (a wrong token, the server down)
are reported in the echo area instead of silently showing no notes; they
are not retried on every Flymake run: `doc-review-refresh' asks again."
  (let ((root (doc-review-project-root project)))
    (setq doc-review--fetching (delete root doc-review--fetching))
    (let* ((code (bound-and-true-p url-http-response-status))
           (err (plist-get status :error))
           (body (progn (goto-char (point-min))
                        (and (re-search-forward "\r?\n\r?\n" nil t)
                             (decode-coding-string
                              (buffer-substring-no-properties (point) (point-max)) 'utf-8))))
           (data (and body (ignore-errors (doc-review--parse-json body)))))
      (if (or err (null code) (>= code 400))
          (progn
            (puthash root nil doc-review--cache)
            (message "%s" (doc-review--t 'fetch-failed
                                         (doc-review--sanitize
                                          (or (let ((m (and (consp data) (alist-get 'error data)))) (and (stringp m) m))
                                              (and code (format "HTTP %s" code))
                                              (and err (error-message-string err))
                                              (doc-review--t 'no-answer))))))
        (when (consp data)
          (puthash root (alist-get 'threads data) doc-review--cache)
          (doc-review--refresh-flymake))))))

(defun doc-review--refresh-flymake ()
  "Rerun Flymake in buffers with `doc-review-mode'."
  (dolist (b (buffer-list))
    (with-current-buffer b
      (when (and (bound-and-true-p doc-review-mode) (bound-and-true-p flymake-mode))
        (flymake-start)))))

;;;###autoload
(define-minor-mode doc-review-mode
  "Show the open review comments as Flymake notes in this source buffer."
  :lighter " Rev"
  (if doc-review-mode
      (progn
        (setq doc-review--mode-project (doc-review--project))
        (add-hook 'flymake-diagnostic-functions #'doc-review-flymake nil t)
        (flymake-mode 1))
    (remove-hook 'flymake-diagnostic-functions #'doc-review-flymake t)))

;;;###autoload
(defun doc-review-maybe-enable ()
  "Enable `doc-review-mode' in a source file of a project.
A project is a directory with a .doc-review.json above the file.
Meant for `org-mode-hook', `LaTeX-mode-hook', `latex-mode-hook' and
`markdown-mode-hook'; nothing happens without a config file."
  (when buffer-file-name
    (let ((project (ignore-errors (doc-review--project (file-name-directory buffer-file-name) t))))
      (when (and project
                 (doc-review-project-document project)
                 (file-exists-p (expand-file-name doc-review-config-file))
                 (doc-review--source-p project buffer-file-name))
        (doc-review-mode 1)))))

;;; Keys

(defvar doc-review-command-map
  (let ((m (make-sparse-keymap)))
    (define-key m (kbd "p") #'doc-review-publish)
    (define-key m (kbd "c") #'doc-review-comments)
    (define-key m (kbd "r") #'doc-review-reply)
    (define-key m (kbd "x") #'doc-review-resolve)
    (define-key m (kbd "X") #'doc-review-reopen)
    (define-key m (kbd "g") #'doc-review-refresh)
    (define-key m (kbd "m") #'doc-review-mode)
    (define-key m (kbd "l") #'doc-review-list-documents)
    (define-key m (kbd "b") #'doc-review-open-in-browser)
    m)
  "Commands of doc-review, under `doc-review-keymap-prefix'.")
(fset 'doc-review-command-map doc-review-command-map)

(defvar doc-review--bound-prefix nil
  "The key `doc-review-command-map' is bound to globally, if any.")

(defun doc-review--set-prefix (symbol value)
  "Set SYMBOL to VALUE and bind `doc-review-command-map' to that key (nil: none)."
  (when (and doc-review--bound-prefix
             (eq (lookup-key global-map (kbd doc-review--bound-prefix)) 'doc-review-command-map))
    (global-unset-key (kbd doc-review--bound-prefix)))
  (set-default symbol value)
  (setq doc-review--bound-prefix value)
  (when value (global-set-key (kbd value) 'doc-review-command-map)))

(defcustom doc-review-keymap-prefix "C-c d"
  "Global prefix key of `doc-review-command-map'; nil binds nothing.
Set it with `setopt' or Customize (or `setq' before loading the package)."
  :type '(choice (const :tag "None" nil) (string :tag "Key"))
  :set #'doc-review--set-prefix)

(provide 'doc-review)
;;; doc-review.el ends here
