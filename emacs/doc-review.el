;;; doc-review.el --- Thesis directors' comments next to the org source -*- lexical-binding: t; -*-

;; Author: Eduardo V.
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: outlines, tools, wp
;; URL: https://github.com/LaloHao/doc-review

;;; Commentary:

;; Client for the doc-review server, where thesis directors comment on the
;; compiled PDF.  From the thesis (any file under the directory that holds
;; tesis.org):
;;
;;   M-x doc-review-publicar     upload tesis.pdf + avance.json as a new version
;;   M-x doc-review-comentarios  open comments in an org buffer, grouped by
;;                                   chapter and page, with links to the org source
;;   M-x doc-review-responder    reply to the thread at point
;;   M-x doc-review-resolver     resolve (C-u: reopen) the thread at point
;;   doc-review-mode             Flymake notes on the commented org text
;;
;; Comments are anchored in the org sources by fuzzy-matching the text the
;; director selected in the PDF: both sides are reduced to lowercase letters and
;; digits (so whitespace, hyphenation, ligatures and punctuation don't matter),
;; after masking org/LaTeX markup, drawers, comments and citations in the source.
;;
;; Configuration: ~/.config/doc-review/config.json with {"url", "token"},
;; readable only by you (chmod 600).  Pure Emacs Lisp: url.el and native JSON.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'url)
(require 'url-http)
(require 'org)
(require 'flymake)
(require 'ucs-normalize)

(defgroup doc-review nil
  "Thesis directors' comments next to the org source."
  :group 'tools
  :prefix "doc-review-")

(defcustom doc-review-config-file
  (expand-file-name "doc-review/config.json"
                    (or (getenv "XDG_CONFIG_HOME") "~/.config"))
  "JSON file with the server URL and the owner token: {\"url\": …, \"token\": …}."
  :type 'file)

(defcustom doc-review-root-file "tesis.org"
  "File that marks the thesis root directory."
  :type 'string)

(defcustom doc-review-pdf-file "tesis.pdf"
  "Compiled PDF, relative to the thesis root."
  :type 'string)

(defcustom doc-review-avance-file "avance.json"
  "Progress file uploaded with each PDF, relative to the thesis root."
  :type 'string)

(defcustom doc-review-avance-command nil
  "Shell command run in the thesis root before publishing.
Use it to regenerate avance.json, for example
\"doc-review avance tesis.org -o avance.json\".  nil = don't run."
  :type '(choice (const nil) string))

(defcustom doc-review-timeout 120
  "Seconds to wait for the server."
  :type 'integer)

(defcustom doc-review-min-quote-length 8
  "Quotes shorter than this (letters and digits) are not anchored in the source."
  :type 'integer)

(defconst doc-review-buffer-name "*doc-review*")

(defvar doc-review--threads nil
  "Open threads from the last fetch (list of alists), used by Flymake.")

(defvar doc-review--fetched nil
  "Non-nil once `doc-review--threads' has been fetched.")

(defvar-local doc-review--buffer-root nil
  "Thesis root of the comments buffer.")

(defvar doc-review--index-cache (make-hash-table :test #'equal)
  "File name → (MTIME . INDEX) for the org sources.")

;;; Untrusted text

(defconst doc-review--unsafe-chars-regexp
  (rx (any (0 . 8) 11 12 (13 . 31) (127 . 159)
           #x61c #x200e #x200f (#x202a . #x202e) (#x2066 . #x2069)
           ;; Raw bytes left by invalid UTF-8.
           (#x3fff80 . #x3fffff)))
  "Control characters (except tab and newline), bidi controls and raw bytes.")

(defun doc-review--sanitize (s)
  "S without control or bidi characters (they come from the directors).
Escape sequences, carriage returns and bidi overrides could make the text
look different from what it is in a buffer, the echo area or Flymake."
  (if (stringp s)
      (replace-regexp-in-string doc-review--unsafe-chars-regexp "" s t t)
    ""))

;;; Configuration and HTTP

(defun doc-review--config ()
  "Return (URL . TOKEN) from `doc-review-config-file'."
  (let ((file (expand-file-name doc-review-config-file)))
    (unless (file-readable-p file)
      (user-error "No existe %s: créalo con {\"url\": …, \"token\": …} y chmod 600" file))
    (let ((modes (file-modes file)))
      (when (and modes (/= 0 (logand modes #o077)))
        (user-error "%s es legible por otros usuarios: ejecuta chmod 600 %s" file file)))
    (let* ((json (with-temp-buffer
                   (insert-file-contents file)
                   (json-parse-buffer :object-type 'alist)))
           (url (alist-get 'url json))
           (token (alist-get 'token json)))
      (unless (and (stringp url) (stringp token) (> (length url) 0) (> (length token) 0))
        (user-error "%s debe tener \"url\" y \"token\"" file))
      (doc-review--check-url url)
      (cons (string-trim-right url "/+") token))))

(defun doc-review--check-url (url)
  "Signal a `user-error' unless URL is https, or http to this machine.
The owner token goes in every request: it must never travel in clear text."
  (let* ((u (url-generic-parse-url url))
         (type (url-type u))
         (host (url-host u)))
    (unless (or (equal type "https")
                (and (equal type "http")
                     (member host '("localhost" "127.0.0.1" "::1" "[::1]"))))
      (user-error "La URL del servidor debe usar https:// (http solo para localhost): %s" url))))

(defun doc-review--parse-json (string)
  "Parse STRING as JSON: objects → alists, arrays → lists, null → nil."
  (json-parse-string string :object-type 'alist :array-type 'list
                     :null-object nil :false-object :false))

(defun doc-review--request (method path &optional body content-type)
  "Send METHOD PATH to the server with the owner token; return the parsed JSON.
BODY is a unibyte string sent with CONTENT-TYPE."
  (let* ((cfg (doc-review--config))
         (url-request-method method)
         (url-request-extra-headers (doc-review--headers (cdr cfg) content-type))
         (url-request-data body)
         (buffer (url-retrieve-synchronously (concat (car cfg) path) t t doc-review-timeout)))
    (unless buffer (error "doc-review: sin respuesta de %s" (car cfg)))
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

(defun doc-review--headers (token &optional content-type)
  "Request headers as unibyte strings.
url.el refuses to send a request whose headers are multibyte (strings read
from JSON are) together with a binary body."
  (mapcar (lambda (h) (cons (car h) (encode-coding-string (cdr h) 'utf-8)))
          (append `(("Authorization" . ,(concat "Bearer " token))
                    ("Accept" . "application/json"))
                  (when content-type `(("Content-Type" . ,content-type))))))

(defun doc-review--handle-response (status text)
  "Return TEXT parsed as JSON, or signal the server's error for STATUS ≥ 400."
  (let ((data (condition-case nil
                  (and (not (string-empty-p (string-trim text)))
                       (doc-review--parse-json text))
                (error nil))))
    (when (or (null status) (>= status 400))
      (user-error "doc-review: %s"
                  (let ((msg (and (consp data) (alist-get 'error data))))
                    (if (stringp msg)
                        (doc-review--sanitize msg)
                      (format "HTTP %s" status)))))
    data))

(defun doc-review--json-body (object)
  "OBJECT as a unibyte UTF-8 JSON string."
  (encode-coding-string (json-serialize object) 'utf-8))

(defun doc-review--multipart (boundary fields)
  "Build a multipart/form-data body (unibyte) with BOUNDARY.
FIELDS is a list of (NAME . STRING) or (NAME :file PATH :type MIME)."
  (with-temp-buffer
    (set-buffer-multibyte nil)
    (dolist (f fields)
      (insert "--" boundary "\r\n")
      (if (and (consp (cdr f)) (eq (cadr f) :file))
          (let ((path (plist-get (cdr f) :file))
                (type (plist-get (cdr f) :type)))
            (insert (format "Content-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                            (car f)
                            (encode-coding-string (file-name-nondirectory path) 'utf-8))
                    "Content-Type: " type "\r\n\r\n")
            (goto-char (point-max))
            (insert-file-contents-literally path))
        (insert (format "Content-Disposition: form-data; name=\"%s\"\r\n\r\n" (car f))
                (encode-coding-string (cdr f) 'utf-8)))
      (goto-char (point-max))
      (insert "\r\n"))
    (insert "--" boundary "--\r\n")
    (buffer-string)))

;;; Thesis files

(defun doc-review--root (&optional dir)
  "Thesis root (the directory with `doc-review-root-file') above DIR."
  (let ((root (locate-dominating-file (or dir default-directory) doc-review-root-file)))
    (unless root
      (user-error "No encontré %s en este directorio ni arriba" doc-review-root-file))
    (file-name-as-directory (expand-file-name root))))

(defun doc-review--org-files (root)
  "All org files of the thesis under ROOT, skipping hidden and build directories."
  (sort (directory-files-recursively
         root "\\.org\\'" nil
         (lambda (dir) (not (string-match-p "/\\.\\|/node_modules\\'\\|/ltximg\\'" dir))))
        #'string<))

(defun doc-review--newest-org-mtime (root)
  "Modification time of the newest org file under ROOT."
  (let (newest)
    (dolist (f (doc-review--org-files root) newest)
      (let ((m (file-attribute-modification-time (file-attributes f))))
        (when (or (null newest) (time-less-p newest m)) (setq newest m))))))

;;;###autoload
(defun doc-review-publicar (note)
  "Upload tesis.pdf and avance.json from the thesis root as a new version.
NOTE is the version note shown to the directors."
  (interactive (list (read-string "Nota de la versión (opcional): ")))
  (let* ((root (doc-review--root))
         (default-directory root)
         (pdf (expand-file-name doc-review-pdf-file root))
         (avance (expand-file-name doc-review-avance-file root)))
    (when doc-review-avance-command
      (let ((status (call-process-shell-command doc-review-avance-command nil nil)))
        (unless (eq status 0)
          (user-error "Falló «%s» (código %s)" doc-review-avance-command status))))
    (unless (file-readable-p pdf) (user-error "No existe %s: compila la tesis primero" pdf))
    (unless (file-readable-p avance)
      (user-error "No existe %s (genéralo con: doc-review avance tesis.org -o avance.json)" avance))
    (let ((newest (doc-review--newest-org-mtime root))
          (pdf-time (file-attribute-modification-time (file-attributes pdf))))
      (when (and newest (time-less-p pdf-time newest)
                 (called-interactively-p 'interactive)
                 (not (y-or-n-p "tesis.pdf es más viejo que las fuentes org. ¿Publicar de todos modos? ")))
        (user-error "Cancelado")))
    (let* ((boundary (format "doc-review-%s" (md5 (format "%s%s" (random) (float-time)))))
           (body (doc-review--multipart
                  boundary
                  `(("pdf" :file ,pdf :type "application/pdf")
                    ("avance" :file ,avance :type "application/json")
                    ("note" . ,note))))
           (r (doc-review--request "POST" "/api/versions" body
                                       (concat "multipart/form-data; boundary=" boundary)))
           (v (alist-get 'version r)))
      (message "Publicada la versión %s (%s páginas): %s"
               (alist-get 'number v) (alist-get 'page_count v)
               (doc-review--clean-heading (alist-get 'url r)))
      r)))

;;; Normalization and anchoring

(defun doc-review--word-char-p (c)
  "Non-nil if C is a letter or a digit."
  (memq (get-char-code-property c 'general-category) '(Lu Ll Lt Lm Lo Nd)))

(defun doc-review--normalize-quote (quote)
  "Reduce a PDF QUOTE to lowercase letters and digits.
Ligatures and compatibility characters are unfolded (NFKC); citation marks
such as [3] or [1, 4–6] are removed (the source has [cite:…] instead)."
  (let* ((s (ucs-normalize-NFKC-string quote))
         (s (replace-regexp-in-string "\u00ad" "" s))
         (s (replace-regexp-in-string "\\[[0-9][0-9,;–— -]*\\]" " " s)))
    (apply #'string (cl-loop for c across (downcase s)
                             when (doc-review--word-char-p c) collect c))))

(defconst doc-review--mask-regexps
  '(;; Blocks whose text isn't in the PDF.
    "^[ \t]*#\\+begin_\\(comment\\|src\\|example\\)\\(?:.\\|\n\\)*?^[ \t]*#\\+end_\\1.*$"
    ;; Drawers (:PROPERTIES: … :END:) and their lines.
    "^[ \t]*:[A-Za-z_-]+:.*$"
    ;; Comments and keywords (#+TITLE, #+LATEX, #+INCLUDE …).
    "^[ \t]*#\\(?:[ +].*\\)?$"
    ;; Citations.
    "\\[cite[^]]*\\]"
    ;; Link targets: [[target][ and [[target]] (descriptions are kept).
    "\\[\\[[^]]*\\]\\[" "\\[\\[[^]]*\\]\\]"
    ;; LaTeX commands (the arguments stay: \\gls{LLM} → LLM).
    "\\\\[a-zA-Z]+\\*?"
    ;; Headline tags.
    "[ \t]+:[[:alnum:]_@#%:]+:[ \t]*$")
  "Source regions replaced by spaces before matching (positions are preserved).")

(defun doc-review--index-string (text)
  "Index TEXT (org source): return (NORMALIZED . POSITIONS).
NORMALIZED has only lowercase letters and digits; POSITIONS maps each of its
characters to a 1-based offset in TEXT."
  (let ((masked (with-temp-buffer
                  (insert text)
                  (dolist (re doc-review--mask-regexps)
                    (goto-char (point-min))
                    (while (re-search-forward re nil t)
                      (if (= (match-beginning 0) (match-end 0))
                          (unless (eobp) (forward-char 1))
                        ;; Spaces instead, keeping newlines and the length.
                        (replace-match (replace-regexp-in-string "[^\n]" " " (match-string 0)) t t))))
                  (buffer-string)))
        (chars nil) (pos nil) (i 0))
    (dolist (c (append masked nil))
      (setq i (1+ i))
      (when (doc-review--word-char-p c)
        (push (downcase c) chars)
        (push i pos)))
    (cons (apply #'string (nreverse chars)) (vconcat (nreverse pos)))))

(defun doc-review--file-index (file)
  "Index of FILE, from its live buffer if visited, cached by modification time."
  (let ((buf (get-file-buffer file)))
    (if (and buf (buffer-modified-p buf))
        (with-current-buffer buf
          (doc-review--index-string (buffer-substring-no-properties (point-min) (point-max))))
      (let* ((mtime (file-attribute-modification-time (file-attributes file)))
             (hit (gethash file doc-review--index-cache)))
        (if (and hit (equal (car hit) mtime))
            (cdr hit)
          (let ((idx (doc-review--index-string
                      (with-temp-buffer (insert-file-contents file) (buffer-string)))))
            (puthash file (cons mtime idx) doc-review--index-cache)
            idx))))))

(defun doc-review--locate-in-index (q index)
  "Find normalized quote Q in INDEX; return (START . END) offsets or nil.
Exact match first.  Otherwise Q is cut in 12-character pieces and the place
of the source where most pieces fall together wins: that survives edits made
after the PDF was compiled and text the PDF expands (\\gls{LLM} → \"modelo
de lenguaje de gran tamaño (LLM)\")."
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
The file named after the thread's chapter id is tried first."
  (let* ((q (doc-review--normalize-quote (or (alist-get 'quote thread) "")))
         (chapter (alist-get 'id (alist-get 'chapter thread)))
         (ordered (if chapter
                      (append (cl-remove-if-not
                               (lambda (f) (equal (file-name-base f) chapter)) files)
                              (cl-remove-if
                               (lambda (f) (equal (file-name-base f) chapter)) files))
                    files)))
    (cl-loop for f in ordered
             for hit = (doc-review--locate-in-index q (doc-review--file-index f))
             when hit return (list f (car hit) (cdr hit)))))

(defun doc-review--line-at (file offset)
  "Line number of 1-based character OFFSET in FILE."
  (with-temp-buffer
    (insert-file-contents file)
    (line-number-at-pos (min offset (point-max)))))

;;; Fetching and the comments buffer

(defun doc-review--fetch-threads (&optional all)
  "Fetch open threads (all with ALL) of every version, newest version first."
  (let ((r (doc-review--request "GET" (concat "/api/threads?status=" (if all "all" "open")))))
    (alist-get 'threads r)))

(defun doc-review--literal (text &optional indent)
  "TEXT as org fixed-width lines (\": …\"), so nothing in it is markup or a link."
  (let ((pad (or indent "")))
    (mapconcat (lambda (l) (concat pad (if (string-empty-p l) ":" (concat ": " l))))
               (split-string (doc-review--sanitize text) "\n") "\n")))

(defun doc-review--clean-heading (s)
  "S safe for an org headline: one line, no link brackets."
  (replace-regexp-in-string "\\[\\[\\|\\]\\]\\|[\n\t]" " " (doc-review--sanitize s)))

(defun doc-review--date (iso)
  "Short local date of ISO."
  (if (and iso (fboundp 'iso8601-parse))
      (condition-case nil
          (format-time-string "%Y-%m-%d %H:%M" (encode-time (iso8601-parse iso)))
        (error iso))
    (or iso "")))

(defun doc-review--insert-thread (thread loc root)
  "Insert THREAD (located at LOC, relative to ROOT) as an org subtree."
  (let* ((comments (alist-get 'comments thread))
         (first (car comments)))
    (insert (format "** p. %s · v%s · %s%s\n"
                    (alist-get 'page thread)
                    (alist-get 'version thread)
                    (doc-review--clean-heading (alist-get 'name (alist-get 'author first)))
                    (if (equal (alist-get 'status thread) "resolved") " · resuelto" "")))
    (insert ":PROPERTIES:\n"
            (format ":DOC_REVIEW_ID: %s\n" (alist-get 'id thread))
            ":END:\n")
    (if loc
        (let ((rel (file-relative-name (nth 0 loc) root))
              (line (doc-review--line-at (nth 0 loc) (nth 1 loc))))
          (insert (format "Fuente: [[file:%s::%d][%s:%d]]\n" (nth 0 loc) line rel line)))
      ;; Not anchored (a point comment, or text that changed): link the chapter file.
      (let* ((chapter (alist-get 'id (alist-get 'chapter thread)))
             (file (and chapter root
                        (cl-find chapter (doc-review--org-files root)
                                 :key #'file-name-base :test #'equal))))
        (when file
          (insert (format "Capítulo: [[file:%s][%s]]\n" file (file-relative-name file root))))))
    (insert (format "Web: [[%s][ver en el PDF]]\n"
                    (doc-review--clean-heading (alist-get 'url thread))))
    (unless (string-empty-p (or (alist-get 'quote thread) ""))
      (insert "Cita:\n" (doc-review--literal (alist-get 'quote thread) "  ") "\n"))
    (dolist (c comments)
      (insert (format "- %s, %s%s:\n"
                      (doc-review--clean-heading (alist-get 'name (alist-get 'author c)))
                      (doc-review--clean-heading (doc-review--date (alist-get 'created_at c)))
                      (if (alist-get 'edited_at c) " (editado)" ""))
              (if (eq (alist-get 'deleted c) t)
                  "  : (comentario eliminado)"
                (doc-review--literal (alist-get 'body c) "  "))
              "\n"))
    (insert "\n")))

(defun doc-review--render (threads root)
  "Insert THREADS grouped by chapter, anchored in the org files under ROOT."
  (let* ((files (and root (doc-review--org-files root)))
         (located (mapcar (lambda (th) (cons th (and files (doc-review--locate th files)))) threads))
         (anchored (cl-remove-if-not #'cdr located))
         (unanchored (cl-remove-if #'cdr located))
         (groups nil))
    (dolist (pair anchored)
      (let* ((ch (alist-get 'chapter (car pair)))
             (key (or (alist-get 'title ch) "Sin capítulo")))
        (push pair (alist-get key groups nil nil #'equal))))
    (insert (format "#+TITLE: Comentarios de los directores\n#+STARTUP: content\n\n%d hilo(s) abiertos. g: actualizar · r: responder · c: resolver (C-u c: reabrir)\n\n"
                    (length threads)))
    (dolist (g (nreverse groups))
      (insert (format "* %s\n" (doc-review--clean-heading (car g))))
      (dolist (pair (sort (nreverse (cdr g))
                          (lambda (a b) (< (alist-get 'page (car a)) (alist-get 'page (car b))))))
        (doc-review--insert-thread (car pair) (cdr pair) root)))
    (when unanchored
      (insert "* Sin ubicar en el código fuente\n")
      (dolist (pair unanchored)
        (doc-review--insert-thread (car pair) nil root)))))

(defvar doc-review-comments-mode-map
  (let ((m (make-sparse-keymap)))
    (define-key m (kbd "g") #'doc-review-comentarios)
    (define-key m (kbd "r") #'doc-review-responder)
    (define-key m (kbd "c") #'doc-review-resolver)
    m)
  "Keys of the comments buffer.")

(define-minor-mode doc-review-comments-mode
  "Keys for the doc-review comments buffer."
  :lighter " Revisión"
  :keymap doc-review-comments-mode-map)

;;;###autoload
(defun doc-review-comentarios (&optional all)
  "Show the open comments (all with prefix ALL) in an org buffer."
  (interactive "P")
  (let* ((existing (get-buffer doc-review-buffer-name))
         (root (or (ignore-errors (doc-review--root))
                   (and existing (buffer-local-value 'doc-review--buffer-root existing))))
         (threads (doc-review--fetch-threads all)))
    (unless all (setq doc-review--threads threads doc-review--fetched t))
    (with-current-buffer (get-buffer-create doc-review-buffer-name)
      (let ((inhibit-read-only t))
        (erase-buffer)
        (org-mode)
        (setq-local doc-review--buffer-root root)
        (doc-review--render threads root)
        (goto-char (point-min))
        (doc-review-comments-mode 1)
        (setq buffer-read-only t)
        (set-buffer-modified-p nil)))
    (doc-review--refresh-flymake)
    (unless noninteractive (pop-to-buffer doc-review-buffer-name))
    threads))

;;; Thread at point, reply, resolve

(defun doc-review--thread-at-point ()
  "Thread id at point: comments buffer heading, Flymake note, or prompt."
  (or (when (derived-mode-p 'org-mode)
        (let ((id (org-entry-get nil "DOC_REVIEW_ID" t)))
          (and id (string-to-number id))))
      (cl-loop for d in (flymake-diagnostics (point))
               when (eq (flymake-diagnostic-backend d) #'doc-review-flymake)
               return (flymake-diagnostic-data d))
      (let* ((threads (or doc-review--threads (doc-review--fetch-threads)))
             (choices (mapcar (lambda (th)
                                (cons (format "#%s p. %s · %s: %s"
                                              (alist-get 'id th) (alist-get 'page th)
                                              (doc-review--clean-heading
                                               (alist-get 'name (alist-get 'author th)))
                                              (truncate-string-to-width
                                               (doc-review--clean-heading
                                                (alist-get 'body (car (alist-get 'comments th))))
                                               60))
                                      (alist-get 'id th)))
                              threads)))
        (unless choices (user-error "No hay comentarios abiertos"))
        (cdr (assoc (completing-read "Hilo: " choices nil t) choices)))))

;;;###autoload
(defun doc-review-responder (id text)
  "Reply TEXT to thread ID (the one at point by default)."
  (interactive (let ((id (doc-review--thread-at-point)))
                 (list id (read-string (format "Respuesta al hilo #%s: " id)))))
  (when (string-empty-p (string-trim text)) (user-error "Respuesta vacía"))
  (doc-review--request "POST" (format "/api/threads/%d/comments" id)
                           (doc-review--json-body `((body . ,text)))
                           "application/json")
  (message "Respuesta enviada al hilo #%s" id)
  (doc-review--after-change))

;;;###autoload
(defun doc-review-resolver (id &optional reopen)
  "Mark thread ID resolved; with prefix REOPEN, reopen it."
  (interactive (list (doc-review--thread-at-point) current-prefix-arg))
  (doc-review--request "POST" (format "/api/threads/%d/%s" id (if reopen "reopen" "resolve")))
  (message "Hilo #%s %s" id (if reopen "reabierto" "resuelto"))
  (doc-review--after-change))

(defun doc-review--after-change ()
  "Refresh the comments buffer if it exists, else the Flymake cache."
  (if (get-buffer doc-review-buffer-name)
      (with-current-buffer doc-review-buffer-name
        (let ((default-directory (or doc-review--buffer-root default-directory)))
          (doc-review-comentarios)))
    (setq doc-review--threads (doc-review--fetch-threads) doc-review--fetched t)
    (doc-review--refresh-flymake)))

;;; Flymake

(defun doc-review--diagnostic-text (thread)
  "One-line summary of THREAD for Flymake."
  (let* ((cs (alist-get 'comments thread))
         (last (car (last (cl-remove-if (lambda (c) (eq (alist-get 'deleted c) t)) cs)))))
    (format "%s (v%s p. %s%s): %s"
            (doc-review--clean-heading (alist-get 'name (alist-get 'author (car cs))))
            (alist-get 'version thread) (alist-get 'page thread)
            (if (> (length cs) 1) (format ", %d mensajes" (length cs)) "")
            (replace-regexp-in-string "[\n\t]+" " " (doc-review--sanitize (alist-get 'body last))))))

(defun doc-review--buffer-diagnostics (threads)
  "Flymake diagnostics for THREADS anchored in the current buffer."
  (let ((index (doc-review--index-string
                (buffer-substring-no-properties (point-min) (point-max))))
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

(defun doc-review-flymake (report-fn &rest _)
  "Flymake backend: open directors' comments as notes on the matching text."
  (funcall report-fn
           (if doc-review--fetched
               (doc-review--buffer-diagnostics doc-review--threads)
             (doc-review--fetch-async)
             nil)))

(defvar doc-review--fetching nil)

(defun doc-review--fetch-async ()
  "Fetch open threads in the background, then rerun Flymake."
  (unless (or doc-review--fetching noninteractive)
    (let ((cfg (ignore-errors (doc-review--config))))
      (when cfg
        (setq doc-review--fetching t)
        (let ((url-request-method "GET")
              (url-request-extra-headers (doc-review--headers (cdr cfg))))
          (url-retrieve
           (concat (car cfg) "/api/threads?status=open")
           (lambda (status)
             (unwind-protect (doc-review--fetch-async-done status)
               (kill-buffer (current-buffer))))
           nil t t))))))

(defun doc-review--fetch-async-done (status)
  "Handle the response of `doc-review--fetch-async' (current buffer).
STATUS is url.el's status plist.  Errors (a wrong token, the server down)
are reported in the echo area instead of silently showing no notes; they
are not retried on every Flymake run: `doc-review-actualizar' asks again."
  (setq doc-review--fetching nil)
  (let* ((code (bound-and-true-p url-http-response-status))
         (err (plist-get status :error))
         (body (progn (goto-char (point-min))
                      (and (re-search-forward "\r?\n\r?\n" nil t)
                           (decode-coding-string
                            (buffer-substring-no-properties (point) (point-max)) 'utf-8))))
         (data (and body (ignore-errors (doc-review--parse-json body)))))
    (if (or err (null code) (>= code 400))
        (progn
          (setq doc-review--threads nil doc-review--fetched t)
          (message "doc-review: no se pudieron descargar los comentarios: %s (M-x doc-review-actualizar para reintentar)"
                   (doc-review--sanitize
                    (or (let ((m (and (consp data) (alist-get 'error data)))) (and (stringp m) m))
                        (and code (format "HTTP %s" code))
                        (and err (error-message-string err))
                        "sin respuesta"))))
      (when (consp data)
        (setq doc-review--threads (alist-get 'threads data)
              doc-review--fetched t)
        (doc-review--refresh-flymake)))))

(defun doc-review--refresh-flymake ()
  "Rerun Flymake in buffers with `doc-review-mode'."
  (dolist (b (buffer-list))
    (with-current-buffer b
      (when (and (bound-and-true-p doc-review-mode) (bound-and-true-p flymake-mode))
        (flymake-start)))))

;;;###autoload
(defun doc-review-actualizar ()
  "Fetch the open comments again and refresh the Flymake notes."
  (interactive)
  (setq doc-review--threads (doc-review--fetch-threads) doc-review--fetched t)
  (doc-review--refresh-flymake)
  (message "%d comentario(s) abiertos" (length doc-review--threads)))

;;;###autoload
(define-minor-mode doc-review-mode
  "Show the directors' open comments as Flymake notes in this org buffer."
  :lighter " Rev"
  (if doc-review-mode
      (progn
        (add-hook 'flymake-diagnostic-functions #'doc-review-flymake nil t)
        (flymake-mode 1))
    (remove-hook 'flymake-diagnostic-functions #'doc-review-flymake t)))

;;;###autoload
(defun doc-review-maybe-enable ()
  "Enable `doc-review-mode' in org files of a thesis (with tesis.org above)."
  (when (and buffer-file-name
             (locate-dominating-file buffer-file-name doc-review-root-file)
             (file-exists-p (expand-file-name doc-review-config-file)))
    (doc-review-mode 1)))

(provide 'doc-review)
;;; doc-review.el ends here
