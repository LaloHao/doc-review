;;; revision-tesis.el --- Thesis directors' comments next to the org source -*- lexical-binding: t; -*-

;; Author: Eduardo V.
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: outlines, tools, wp
;; URL: https://github.com/LaloHao/revision-tesis

;;; Commentary:

;; Client for the revision-tesis server, where thesis directors comment on the
;; compiled PDF.  From the thesis (any file under the directory that holds
;; tesis.org):
;;
;;   M-x revision-tesis-publicar     upload tesis.pdf + avance.json as a new version
;;   M-x revision-tesis-comentarios  open comments in an org buffer, grouped by
;;                                   chapter and page, with links to the org source
;;   M-x revision-tesis-responder    reply to the thread at point
;;   M-x revision-tesis-resolver     resolve (C-u: reopen) the thread at point
;;   revision-tesis-mode             Flymake notes on the commented org text
;;
;; Comments are anchored in the org sources by fuzzy-matching the text the
;; director selected in the PDF: both sides are reduced to lowercase letters and
;; digits (so whitespace, hyphenation, ligatures and punctuation don't matter),
;; after masking org/LaTeX markup, drawers, comments and citations in the source.
;;
;; Configuration: ~/.config/revision-tesis/config.json with {"url", "token"},
;; readable only by you (chmod 600).  Pure Emacs Lisp: url.el and native JSON.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'url)
(require 'url-http)
(require 'org)
(require 'flymake)
(require 'ucs-normalize)

(defgroup revision-tesis nil
  "Thesis directors' comments next to the org source."
  :group 'tools
  :prefix "revision-tesis-")

(defcustom revision-tesis-config-file
  (expand-file-name "revision-tesis/config.json"
                    (or (getenv "XDG_CONFIG_HOME") "~/.config"))
  "JSON file with the server URL and the owner token: {\"url\": …, \"token\": …}."
  :type 'file)

(defcustom revision-tesis-root-file "tesis.org"
  "File that marks the thesis root directory."
  :type 'string)

(defcustom revision-tesis-pdf-file "tesis.pdf"
  "Compiled PDF, relative to the thesis root."
  :type 'string)

(defcustom revision-tesis-avance-file "avance.json"
  "Progress file uploaded with each PDF, relative to the thesis root."
  :type 'string)

(defcustom revision-tesis-avance-command nil
  "Shell command run in the thesis root before publishing.
Use it to regenerate avance.json, for example
\"revision-tesis avance tesis.org -o avance.json\".  nil = don't run."
  :type '(choice (const nil) string))

(defcustom revision-tesis-timeout 120
  "Seconds to wait for the server."
  :type 'integer)

(defcustom revision-tesis-min-quote-length 8
  "Quotes shorter than this (letters and digits) are not anchored in the source."
  :type 'integer)

(defconst revision-tesis-buffer-name "*revision-tesis*")

(defvar revision-tesis--threads nil
  "Open threads from the last fetch (list of alists), used by Flymake.")

(defvar revision-tesis--fetched nil
  "Non-nil once `revision-tesis--threads' has been fetched.")

(defvar-local revision-tesis--buffer-root nil
  "Thesis root of the comments buffer.")

(defvar revision-tesis--index-cache (make-hash-table :test #'equal)
  "File name → (MTIME . INDEX) for the org sources.")

;;; Configuration and HTTP

(defun revision-tesis--config ()
  "Return (URL . TOKEN) from `revision-tesis-config-file'."
  (let ((file (expand-file-name revision-tesis-config-file)))
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
      (cons (string-trim-right url "/+") token))))

(defun revision-tesis--parse-json (string)
  "Parse STRING as JSON: objects → alists, arrays → lists, null → nil."
  (json-parse-string string :object-type 'alist :array-type 'list
                     :null-object nil :false-object :false))

(defun revision-tesis--request (method path &optional body content-type)
  "Send METHOD PATH to the server with the owner token; return the parsed JSON.
BODY is a unibyte string sent with CONTENT-TYPE."
  (let* ((cfg (revision-tesis--config))
         (url-request-method method)
         (url-request-extra-headers
          (append `(("Authorization" . ,(concat "Bearer " (cdr cfg)))
                    ("Accept" . "application/json"))
                  (when content-type `(("Content-Type" . ,content-type)))))
         (url-request-data body)
         (buffer (url-retrieve-synchronously (concat (car cfg) path) t t revision-tesis-timeout)))
    (unless buffer (error "revision-tesis: sin respuesta de %s" (car cfg)))
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
            (revision-tesis--handle-response status text)))
      (kill-buffer buffer))))

(defun revision-tesis--handle-response (status text)
  "Return TEXT parsed as JSON, or signal the server's error for STATUS ≥ 400."
  (let ((data (condition-case nil
                  (and (not (string-empty-p (string-trim text)))
                       (revision-tesis--parse-json text))
                (error nil))))
    (when (or (null status) (>= status 400))
      (user-error "revision-tesis: %s"
                  (or (and (consp data) (alist-get 'error data))
                      (format "HTTP %s" status))))
    data))

(defun revision-tesis--json-body (object)
  "OBJECT as a unibyte UTF-8 JSON string."
  (encode-coding-string (json-serialize object) 'utf-8))

(defun revision-tesis--multipart (boundary fields)
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

(defun revision-tesis--root (&optional dir)
  "Thesis root (the directory with `revision-tesis-root-file') above DIR."
  (let ((root (locate-dominating-file (or dir default-directory) revision-tesis-root-file)))
    (unless root
      (user-error "No encontré %s en este directorio ni arriba" revision-tesis-root-file))
    (file-name-as-directory (expand-file-name root))))

(defun revision-tesis--org-files (root)
  "All org files of the thesis under ROOT, skipping hidden and build directories."
  (sort (directory-files-recursively
         root "\\.org\\'" nil
         (lambda (dir) (not (string-match-p "/\\.\\|/node_modules\\'\\|/ltximg\\'" dir))))
        #'string<))

(defun revision-tesis--newest-org-mtime (root)
  "Modification time of the newest org file under ROOT."
  (let (newest)
    (dolist (f (revision-tesis--org-files root) newest)
      (let ((m (file-attribute-modification-time (file-attributes f))))
        (when (or (null newest) (time-less-p newest m)) (setq newest m))))))

;;;###autoload
(defun revision-tesis-publicar (note)
  "Upload tesis.pdf and avance.json from the thesis root as a new version.
NOTE is the version note shown to the directors."
  (interactive (list (read-string "Nota de la versión (opcional): ")))
  (let* ((root (revision-tesis--root))
         (default-directory root)
         (pdf (expand-file-name revision-tesis-pdf-file root))
         (avance (expand-file-name revision-tesis-avance-file root)))
    (when revision-tesis-avance-command
      (let ((status (call-process-shell-command revision-tesis-avance-command nil nil)))
        (unless (eq status 0)
          (user-error "Falló «%s» (código %s)" revision-tesis-avance-command status))))
    (unless (file-readable-p pdf) (user-error "No existe %s: compila la tesis primero" pdf))
    (unless (file-readable-p avance)
      (user-error "No existe %s (genéralo con: revision-tesis avance tesis.org -o avance.json)" avance))
    (let ((newest (revision-tesis--newest-org-mtime root))
          (pdf-time (file-attribute-modification-time (file-attributes pdf))))
      (when (and newest (time-less-p pdf-time newest)
                 (called-interactively-p 'interactive)
                 (not (y-or-n-p "tesis.pdf es más viejo que las fuentes org. ¿Publicar de todos modos? ")))
        (user-error "Cancelado")))
    (let* ((boundary (format "revision-tesis-%s" (md5 (format "%s%s" (random) (float-time)))))
           (body (revision-tesis--multipart
                  boundary
                  `(("pdf" :file ,pdf :type "application/pdf")
                    ("avance" :file ,avance :type "application/json")
                    ("note" . ,note))))
           (r (revision-tesis--request "POST" "/api/versions" body
                                       (concat "multipart/form-data; boundary=" boundary)))
           (v (alist-get 'version r)))
      (message "Publicada la versión %s (%s páginas): %s"
               (alist-get 'number v) (alist-get 'page_count v) (alist-get 'url r))
      r)))

;;; Normalization and anchoring

(defun revision-tesis--word-char-p (c)
  "Non-nil if C is a letter or a digit."
  (memq (get-char-code-property c 'general-category) '(Lu Ll Lt Lm Lo Nd)))

(defun revision-tesis--normalize-quote (quote)
  "Reduce a PDF QUOTE to lowercase letters and digits.
Ligatures and compatibility characters are unfolded (NFKC); citation marks
such as [3] or [1, 4–6] are removed (the source has [cite:…] instead)."
  (let* ((s (ucs-normalize-NFKC-string quote))
         (s (replace-regexp-in-string "\u00ad" "" s))
         (s (replace-regexp-in-string "\\[[0-9][0-9,;–— -]*\\]" " " s)))
    (apply #'string (cl-loop for c across (downcase s)
                             when (revision-tesis--word-char-p c) collect c))))

(defconst revision-tesis--mask-regexps
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

(defun revision-tesis--index-string (text)
  "Index TEXT (org source): return (NORMALIZED . POSITIONS).
NORMALIZED has only lowercase letters and digits; POSITIONS maps each of its
characters to a 1-based offset in TEXT."
  (let ((masked (with-temp-buffer
                  (insert text)
                  (dolist (re revision-tesis--mask-regexps)
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
      (when (revision-tesis--word-char-p c)
        (push (downcase c) chars)
        (push i pos)))
    (cons (apply #'string (nreverse chars)) (vconcat (nreverse pos)))))

(defun revision-tesis--file-index (file)
  "Index of FILE, from its live buffer if visited, cached by modification time."
  (let ((buf (get-file-buffer file)))
    (if (and buf (buffer-modified-p buf))
        (with-current-buffer buf
          (revision-tesis--index-string (buffer-substring-no-properties (point-min) (point-max))))
      (let* ((mtime (file-attribute-modification-time (file-attributes file)))
             (hit (gethash file revision-tesis--index-cache)))
        (if (and hit (equal (car hit) mtime))
            (cdr hit)
          (let ((idx (revision-tesis--index-string
                      (with-temp-buffer (insert-file-contents file) (buffer-string)))))
            (puthash file (cons mtime idx) revision-tesis--index-cache)
            idx))))))

(defun revision-tesis--locate-in-index (q index)
  "Find normalized quote Q in INDEX; return (START . END) offsets or nil.
Exact match first; otherwise the first and last 24 characters of Q, which
survive small edits made after the PDF was compiled."
  (let ((text (car index)) (pos (cdr index)) (n (length q)))
    (when (>= n revision-tesis-min-quote-length)
      (let ((i (string-search q text)))
        (if i
            (cons (aref pos i) (1+ (aref pos (+ i n -1))))
          (when (>= n 32)
            (let* ((k 24)
                   (head (substring q 0 k))
                   (tail (substring q (- n k)))
                   (a (string-search head text))
                   (b (and a (string-search tail text (+ a k)))))
              (cond
               ((and a b (< (- (+ b k) a) (+ (* 2 n) 200)))
                (cons (aref pos a) (1+ (aref pos (+ b k -1)))))
               (a (cons (aref pos a) (1+ (aref pos (+ a k -1)))))
               (t (let ((b2 (string-search tail text)))
                    (and b2 (cons (aref pos b2) (1+ (aref pos (+ b2 k -1)))))))))))))))

(defun revision-tesis--locate (thread files)
  "Locate THREAD's quote in FILES: return (FILE START END) or nil.
The file named after the thread's chapter id is tried first."
  (let* ((q (revision-tesis--normalize-quote (or (alist-get 'quote thread) "")))
         (chapter (alist-get 'id (alist-get 'chapter thread)))
         (ordered (if chapter
                      (append (cl-remove-if-not
                               (lambda (f) (equal (file-name-base f) chapter)) files)
                              (cl-remove-if
                               (lambda (f) (equal (file-name-base f) chapter)) files))
                    files)))
    (cl-loop for f in ordered
             for hit = (revision-tesis--locate-in-index q (revision-tesis--file-index f))
             when hit return (list f (car hit) (cdr hit)))))

(defun revision-tesis--line-at (file offset)
  "Line number of 1-based character OFFSET in FILE."
  (with-temp-buffer
    (insert-file-contents file)
    (line-number-at-pos (min offset (point-max)))))

;;; Fetching and the comments buffer

(defun revision-tesis--fetch-threads (&optional all)
  "Fetch open threads (all with ALL) of every version, newest version first."
  (let ((r (revision-tesis--request "GET" (concat "/api/threads?status=" (if all "all" "open")))))
    (alist-get 'threads r)))

(defun revision-tesis--literal (text &optional indent)
  "TEXT as org fixed-width lines (\": …\"), so nothing in it is markup or a link."
  (let ((pad (or indent "")))
    (mapconcat (lambda (l) (concat pad (if (string-empty-p l) ":" (concat ": " l))))
               (split-string (or text "") "\n") "\n")))

(defun revision-tesis--clean-heading (s)
  "S safe for an org headline: one line, no link brackets."
  (replace-regexp-in-string "\\[\\[\\|\\]\\]\\|[\n\r]" " " (or s "")))

(defun revision-tesis--date (iso)
  "Short local date of ISO."
  (if (and iso (fboundp 'iso8601-parse))
      (condition-case nil
          (format-time-string "%Y-%m-%d %H:%M" (encode-time (iso8601-parse iso)))
        (error iso))
    (or iso "")))

(defun revision-tesis--insert-thread (thread loc root)
  "Insert THREAD (located at LOC, relative to ROOT) as an org subtree."
  (let* ((comments (alist-get 'comments thread))
         (first (car comments)))
    (insert (format "** p. %s · v%s · %s%s\n"
                    (alist-get 'page thread)
                    (alist-get 'version thread)
                    (revision-tesis--clean-heading (alist-get 'name (alist-get 'author first)))
                    (if (equal (alist-get 'status thread) "resolved") " · resuelto" "")))
    (insert ":PROPERTIES:\n"
            (format ":REVISION_TESIS_ID: %s\n" (alist-get 'id thread))
            ":END:\n")
    (when loc
      (let ((rel (file-relative-name (nth 0 loc) root))
            (line (revision-tesis--line-at (nth 0 loc) (nth 1 loc))))
        (insert (format "Fuente: [[file:%s::%d][%s:%d]]\n" (nth 0 loc) line rel line))))
    (insert (format "Web: [[%s][ver en el PDF]]\n"
                    (revision-tesis--clean-heading (alist-get 'url thread))))
    (unless (string-empty-p (or (alist-get 'quote thread) ""))
      (insert "Cita:\n" (revision-tesis--literal (alist-get 'quote thread) "  ") "\n"))
    (dolist (c comments)
      (insert (format "- %s, %s%s:\n"
                      (revision-tesis--clean-heading (alist-get 'name (alist-get 'author c)))
                      (revision-tesis--date (alist-get 'created_at c))
                      (if (alist-get 'edited_at c) " (editado)" ""))
              (if (eq (alist-get 'deleted c) t)
                  "  : (comentario eliminado)"
                (revision-tesis--literal (alist-get 'body c) "  "))
              "\n"))
    (insert "\n")))

(defun revision-tesis--render (threads root)
  "Insert THREADS grouped by chapter, anchored in the org files under ROOT."
  (let* ((files (and root (revision-tesis--org-files root)))
         (located (mapcar (lambda (th) (cons th (and files (revision-tesis--locate th files)))) threads))
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
      (insert (format "* %s\n" (revision-tesis--clean-heading (car g))))
      (dolist (pair (sort (nreverse (cdr g))
                          (lambda (a b) (< (alist-get 'page (car a)) (alist-get 'page (car b))))))
        (revision-tesis--insert-thread (car pair) (cdr pair) root)))
    (when unanchored
      (insert "* Sin ubicar en el código fuente\n")
      (dolist (pair unanchored)
        (revision-tesis--insert-thread (car pair) nil root)))))

(defvar revision-tesis-comments-mode-map
  (let ((m (make-sparse-keymap)))
    (define-key m (kbd "g") #'revision-tesis-comentarios)
    (define-key m (kbd "r") #'revision-tesis-responder)
    (define-key m (kbd "c") #'revision-tesis-resolver)
    m)
  "Keys of the comments buffer.")

(define-minor-mode revision-tesis-comments-mode
  "Keys for the revision-tesis comments buffer."
  :lighter " Revisión"
  :keymap revision-tesis-comments-mode-map)

;;;###autoload
(defun revision-tesis-comentarios (&optional all)
  "Show the open comments (all with prefix ALL) in an org buffer."
  (interactive "P")
  (let* ((existing (get-buffer revision-tesis-buffer-name))
         (root (or (ignore-errors (revision-tesis--root))
                   (and existing (buffer-local-value 'revision-tesis--buffer-root existing))))
         (threads (revision-tesis--fetch-threads all)))
    (unless all (setq revision-tesis--threads threads revision-tesis--fetched t))
    (with-current-buffer (get-buffer-create revision-tesis-buffer-name)
      (let ((inhibit-read-only t))
        (erase-buffer)
        (org-mode)
        (setq-local revision-tesis--buffer-root root)
        (revision-tesis--render threads root)
        (goto-char (point-min))
        (revision-tesis-comments-mode 1)
        (setq buffer-read-only t)
        (set-buffer-modified-p nil)))
    (revision-tesis--refresh-flymake)
    (unless noninteractive (pop-to-buffer revision-tesis-buffer-name))
    threads))

;;; Thread at point, reply, resolve

(defun revision-tesis--thread-at-point ()
  "Thread id at point: comments buffer heading, Flymake note, or prompt."
  (or (when (derived-mode-p 'org-mode)
        (let ((id (org-entry-get nil "REVISION_TESIS_ID" t)))
          (and id (string-to-number id))))
      (cl-loop for d in (flymake-diagnostics (point))
               when (eq (flymake-diagnostic-backend d) #'revision-tesis-flymake)
               return (flymake-diagnostic-data d))
      (let* ((threads (or revision-tesis--threads (revision-tesis--fetch-threads)))
             (choices (mapcar (lambda (th)
                                (cons (format "#%s p. %s · %s: %s"
                                              (alist-get 'id th) (alist-get 'page th)
                                              (alist-get 'name (alist-get 'author th))
                                              (truncate-string-to-width
                                               (or (alist-get 'body (car (alist-get 'comments th))) "") 60))
                                      (alist-get 'id th)))
                              threads)))
        (unless choices (user-error "No hay comentarios abiertos"))
        (cdr (assoc (completing-read "Hilo: " choices nil t) choices)))))

;;;###autoload
(defun revision-tesis-responder (id text)
  "Reply TEXT to thread ID (the one at point by default)."
  (interactive (let ((id (revision-tesis--thread-at-point)))
                 (list id (read-string (format "Respuesta al hilo #%s: " id)))))
  (when (string-empty-p (string-trim text)) (user-error "Respuesta vacía"))
  (revision-tesis--request "POST" (format "/api/threads/%d/comments" id)
                           (revision-tesis--json-body `((body . ,text)))
                           "application/json")
  (message "Respuesta enviada al hilo #%s" id)
  (revision-tesis--after-change))

;;;###autoload
(defun revision-tesis-resolver (id &optional reopen)
  "Mark thread ID resolved; with prefix REOPEN, reopen it."
  (interactive (list (revision-tesis--thread-at-point) current-prefix-arg))
  (revision-tesis--request "POST" (format "/api/threads/%d/%s" id (if reopen "reopen" "resolve")))
  (message "Hilo #%s %s" id (if reopen "reabierto" "resuelto"))
  (revision-tesis--after-change))

(defun revision-tesis--after-change ()
  "Refresh the comments buffer if it exists, else the Flymake cache."
  (if (get-buffer revision-tesis-buffer-name)
      (with-current-buffer revision-tesis-buffer-name
        (let ((default-directory (or revision-tesis--buffer-root default-directory)))
          (revision-tesis-comentarios)))
    (setq revision-tesis--threads (revision-tesis--fetch-threads) revision-tesis--fetched t)
    (revision-tesis--refresh-flymake)))

;;; Flymake

(defun revision-tesis--diagnostic-text (thread)
  "One-line summary of THREAD for Flymake."
  (let* ((cs (alist-get 'comments thread))
         (last (car (last (cl-remove-if (lambda (c) (eq (alist-get 'deleted c) t)) cs)))))
    (format "%s (v%s p. %s%s): %s"
            (alist-get 'name (alist-get 'author (car cs)))
            (alist-get 'version thread) (alist-get 'page thread)
            (if (> (length cs) 1) (format ", %d mensajes" (length cs)) "")
            (replace-regexp-in-string "[\n\r]+" " " (or (alist-get 'body last) "")))))

(defun revision-tesis--buffer-diagnostics (threads)
  "Flymake diagnostics for THREADS anchored in the current buffer."
  (let ((index (revision-tesis--index-string
                (buffer-substring-no-properties (point-min) (point-max))))
        diags)
    (dolist (th threads (nreverse diags))
      (let* ((q (revision-tesis--normalize-quote (or (alist-get 'quote th) "")))
             (hit (revision-tesis--locate-in-index q index)))
        (when hit
          (push (flymake-make-diagnostic
                 (current-buffer)
                 (+ (point-min) (1- (car hit))) (+ (point-min) (1- (cdr hit)))
                 :note (revision-tesis--diagnostic-text th) (alist-get 'id th))
                diags))))))

(defun revision-tesis-flymake (report-fn &rest _)
  "Flymake backend: open directors' comments as notes on the matching text."
  (funcall report-fn
           (if revision-tesis--fetched
               (revision-tesis--buffer-diagnostics revision-tesis--threads)
             (revision-tesis--fetch-async)
             nil)))

(defvar revision-tesis--fetching nil)

(defun revision-tesis--fetch-async ()
  "Fetch open threads in the background, then rerun Flymake."
  (unless (or revision-tesis--fetching noninteractive)
    (let ((cfg (ignore-errors (revision-tesis--config))))
      (when cfg
        (setq revision-tesis--fetching t)
        (let ((url-request-method "GET")
              (url-request-extra-headers `(("Authorization" . ,(concat "Bearer " (cdr cfg)))
                                           ("Accept" . "application/json"))))
          (url-retrieve
           (concat (car cfg) "/api/threads?status=open")
           (lambda (status)
             (setq revision-tesis--fetching nil)
             (unless (plist-get status :error)
               (goto-char (point-min))
               (when (re-search-forward "\r?\n\r?\n" nil t)
                 (let ((data (ignore-errors
                               (revision-tesis--parse-json
                                (decode-coding-string
                                 (buffer-substring-no-properties (point) (point-max)) 'utf-8)))))
                   (when data
                     (setq revision-tesis--threads (alist-get 'threads data)
                           revision-tesis--fetched t)
                     (revision-tesis--refresh-flymake)))))
             (kill-buffer (current-buffer)))
           nil t t))))))

(defun revision-tesis--refresh-flymake ()
  "Rerun Flymake in buffers with `revision-tesis-mode'."
  (dolist (b (buffer-list))
    (with-current-buffer b
      (when (and (bound-and-true-p revision-tesis-mode) (bound-and-true-p flymake-mode))
        (flymake-start)))))

;;;###autoload
(defun revision-tesis-actualizar ()
  "Fetch the open comments again and refresh the Flymake notes."
  (interactive)
  (setq revision-tesis--threads (revision-tesis--fetch-threads) revision-tesis--fetched t)
  (revision-tesis--refresh-flymake)
  (message "%d comentario(s) abiertos" (length revision-tesis--threads)))

;;;###autoload
(define-minor-mode revision-tesis-mode
  "Show the directors' open comments as Flymake notes in this org buffer."
  :lighter " Rev"
  (if revision-tesis-mode
      (progn
        (add-hook 'flymake-diagnostic-functions #'revision-tesis-flymake nil t)
        (flymake-mode 1))
    (remove-hook 'flymake-diagnostic-functions #'revision-tesis-flymake t)))

;;;###autoload
(defun revision-tesis-maybe-enable ()
  "Enable `revision-tesis-mode' in org files of a thesis (with tesis.org above)."
  (when (and buffer-file-name
             (locate-dominating-file buffer-file-name revision-tesis-root-file)
             (file-exists-p (expand-file-name revision-tesis-config-file)))
    (revision-tesis-mode 1)))

(provide 'revision-tesis)
;;; revision-tesis.el ends here
