;;; doc-review-test.el --- ERT tests for doc-review.el -*- lexical-binding: t; -*-

;; Run: make test-emacs
;; HTTP is mocked: no test talks to a server.  The evil test runs only when
;; evil is on the load path (make test-emacs EVIL=/path/to/evil).

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'doc-review)

(defconst doc-review-test--chapter
  "* Introducción
:PROPERTIES:
:CUSTOM_ID: cap-introduccion
:END:

** Antecedentes

La analítica de datos de viajes se está incorporando con rapidez al
planificación del transporte público. Esto genera un modelo que se integra sin una revisión
formal suficiente [cite:@example2024routes] y que empieza a producir rutas poco eficientes.
# Un comentario que no aparece en el PDF.
#+begin_comment
Una nota que tampoco aparece.
#+end_comment
Un \\gls{LLM} /local/ procesa los datos de viajes sin que salgan de la organización.
")

(defconst doc-review-test--tex
  "\\section{Method}\\label{sec:method}
% TODO: rewrite this paragraph, it is not in the PDF.
Trip data is \\emph{anonymized} before it reaches the model
\\cite[p.~3]{example2024routes}, which keeps 100\\% of the personal data inside.
\\begin{figure}\\includegraphics[width=\\linewidth]{fig/pipeline.pdf}\\end{figure}
")

(defconst doc-review-test--md
  "---
title: Report
---
# Findings

The **quarterly** numbers improved, see [the dashboard](https://example.com/very/long/url) for details [@acme2026].
<!-- a hidden note about the client -->
```
code that is not in the PDF
```
")

(defmacro doc-review-test--with-project (json &rest body)
  "Run BODY with `root' bound to a temporary project whose .doc-review.json is JSON."
  (declare (indent 1))
  `(let* ((root (file-name-as-directory (make-temp-file "doc-review-test" t)))
          (doc-review--index-cache (make-hash-table :test #'equal))
          (doc-review--cache (make-hash-table :test #'equal)))
     (unwind-protect
         (progn
           (make-directory (expand-file-name "capitulos" root))
           (make-directory (expand-file-name ".git" root))
           (with-temp-file (expand-file-name ".doc-review.json" root) (insert ,json))
           (with-temp-file (expand-file-name "tesis.org" root)
             (insert "#+TITLE: Tesis\n#+INCLUDE: \"capitulos/01-introduccion.org\" :minlevel 1\n"))
           (with-temp-file (expand-file-name "capitulos/01-introduccion.org" root)
             (insert doc-review-test--chapter))
           (with-temp-file (expand-file-name "capitulos/02-marco.org" root)
             (insert "* Marco teórico\n\nUna ruta de transporte público es una secuencia de paradas.\n"))
           (with-temp-file (expand-file-name ".git/HEAD.org" root) (insert "* nope\n"))
           ,@body)
       (delete-directory root t))))

(defconst doc-review-test--json
  "{\"document\": \"thesis\", \"pdf\": \"tesis.pdf\", \"progress\": \"avance.json\", \"sources\": [\"tesis.org\", \"capitulos/*.org\"]}")

(defun doc-review-test--thread (id page quote body &optional section)
  "A thread alist as the server returns it."
  `((id . ,id) (document . "thesis") (version . 2) (page . ,page) (anchor . "text") (quote . ,quote)
    (status . "open") (url . ,(format "https://r.example/d/thesis/v/2#thread-%d" id))
    (section . ,(and section `((id . ,section) (title . "Introducción"))))
    (author . ((kind . "reviewer") (name . "Dra. Ana Torres Ruiz") (role . "Director")))
    (comments . (((id . ,(* 10 id)) (author . ((kind . "reviewer") (name . "Dra. Ana Torres Ruiz") (role . "Director")))
                  (body . ,body) (created_at . "2026-10-24T18:00:00Z") (edited_at . nil) (deleted . :false))))))

(defmacro doc-review-test--mock (response &rest body)
  "Run BODY with `doc-review--request' returning RESPONSE; bind `calls'."
  (declare (indent 1))
  `(let ((calls nil))
     (cl-letf (((symbol-function 'doc-review--request)
                (lambda (_project method path &optional data type)
                  (push (list method path data type) calls)
                  ,response)))
       ,@body)))

(defun doc-review-test--config (json &optional mode)
  "A config file with JSON (mode MODE, default 0600)."
  (let ((f (make-temp-file "dr-config" nil ".json" json)))
    (set-file-modes f (or mode #o600))
    f))

;;; Normalization and anchoring

(ert-deftest doc-review-test-normalize-quote ()
  (should (equal (doc-review--normalize-quote "Una revi-\nsión  ﬁnal [12] del  ﬂujo, [3, 4–6]")
                 "unarevisiónfinaldelflujo"))
  (should (equal (doc-review--normalize-quote "Post-Mortem­") "postmortem")))

(ert-deftest doc-review-test-locate-exact-across-org-markup ()
  (let* ((index (doc-review--index-string doc-review-test--chapter))
         (q (doc-review--normalize-quote "se integra sin una revi- sión formal suficiente [1] y que empieza"))
         (hit (doc-review--locate-in-index q index)))
    (should hit)
    (should (equal (substring doc-review-test--chapter (1- (car hit)) (1- (cdr hit)))
                   "se integra sin una revisión\nformal suficiente [cite:@example2024routes] y que empieza"))))

(ert-deftest doc-review-test-masks-org-latex-and-comments ()
  (let ((index (doc-review--index-string doc-review-test--chapter)))
    (should (doc-review--locate-in-index (doc-review--normalize-quote "Un LLM local procesa los datos de viajes") index))
    (should-not (string-search "comentario" (car index)))
    (should-not (string-search "tampoco" (car index)))
    (should-not (string-search "customid" (car index)))
    (should-not (string-search "cite" (car index)))))

(ert-deftest doc-review-test-latex-sources ()
  (let ((index (doc-review--index-string doc-review-test--tex 'tex)))
    (should-not (string-search "todo" (car index)))
    (should-not (string-search "example2024routes" (car index)))
    (should-not (string-search "secmethod" (car index)))
    (should-not (string-search "pipeline" (car index)))
    (should-not (string-search "emph" (car index)))
    (let ((hit (doc-review--locate-in-index
                (doc-review--normalize-quote "Trip data is anonymized before it reaches the model [1], which keeps 100% of the secrets")
                index)))
      (should hit)
      (should (string-prefix-p "Trip data is \\emph{anonymized}"
                               (substring doc-review-test--tex (1- (car hit))))))))

(ert-deftest doc-review-test-markdown-sources ()
  (let ((index (doc-review--index-string doc-review-test--md 'md)))
    (should-not (string-search "verylongurl" (car index)))
    (should-not (string-search "hiddennote" (car index)))
    (should-not (string-search "acme2026" (car index)))
    (should-not (string-search "codethat" (car index)))
    (should-not (string-search "titlereport" (car index)))
    (should (doc-review--locate-in-index
             (doc-review--normalize-quote "The quarterly numbers improved, see the dashboard for details")
             index))))

(ert-deftest doc-review-test-format-of-file ()
  (should (eq (doc-review--format "a/b.tex") 'tex))
  (should (eq (doc-review--format "README.md") 'md))
  (should (eq (doc-review--format "x.org") 'org)))

(ert-deftest doc-review-test-locate-fuzzy-after-edit ()
  (let* ((index (doc-review--index-string doc-review-test--chapter))
         (q (doc-review--normalize-quote
             "La analítica de datos de viajes se incorpora muy rápido al planificación del transporte público. Esto genera un modelo")))
    (should (doc-review--locate-in-index q index))))

(ert-deftest doc-review-test-locate-glossary-expansion ()
  (let* ((index (doc-review--index-string doc-review-test--chapter))
         (q (doc-review--normalize-quote
             "Un modelo de lenguaje de gran tamaño (LLM) local procesa los datos de viajes sin que salgan de la organización."))
         (hit (doc-review--locate-in-index q index)))
    (should hit)
    (should (string-match-p "procesa los datos de viajes sin que salgan de la organización"
                            (substring doc-review-test--chapter (1- (car hit)) (1- (cdr hit)))))))

(ert-deftest doc-review-test-unrelated-and-short-quotes-not-anchored ()
  (let ((index (doc-review--index-string doc-review-test--chapter)))
    (should-not (doc-review--locate-in-index
                 (doc-review--normalize-quote "Las redes neuronales convolucionales clasifican imágenes médicas.") index))
    (should-not (doc-review--locate-in-index (doc-review--normalize-quote "Un") index))))

;;; Projects and sources

(ert-deftest doc-review-test-project-file-and-sources ()
  (doc-review-test--with-project doc-review-test--json
    (let ((p (doc-review--project (expand-file-name "capitulos" root))))
      (should (equal (doc-review-project-root p) root))
      (should (equal (doc-review-project-document p) "thesis"))
      (should (equal (doc-review-project-pdf p) "tesis.pdf"))
      (should (equal (mapcar (lambda (f) (file-relative-name f root)) (doc-review--source-files p))
                     '("capitulos/01-introduccion.org" "capitulos/02-marco.org" "tesis.org")))
      (should (doc-review--source-p p (expand-file-name "capitulos/02-marco.org" root)))
      (should-not (doc-review--source-p p (expand-file-name "notes.org" root)))
      ;; Without "sources": every org, tex and md file (hidden directories skipped).
      (setf (doc-review-project-sources p) nil)
      (with-temp-file (expand-file-name "capitulos/extra.tex" root) (insert "x"))
      (should (member "capitulos/extra.tex" (mapcar (lambda (f) (file-relative-name f root)) (doc-review--source-files p))))
      (should-not (cl-some (lambda (f) (string-search "/.git/" f)) (doc-review--source-files p))))
    (should-error (doc-review--project temporary-file-directory) :type 'user-error)))

(ert-deftest doc-review-test-glob-regexp ()
  (should (string-match-p (doc-review--glob-regexp "**/*.org") "a/b/c.org"))
  (should (string-match-p (doc-review--glob-regexp "**/*.org") "c.org"))
  (should-not (string-match-p (doc-review--glob-regexp "capitulos/*.org") "capitulos/x/y.org"))
  (should (string-match-p (doc-review--glob-regexp "ch?.tex") "ch1.tex"))
  (should-not (string-match-p (doc-review--glob-regexp "*.md") "a.mdx")))

(ert-deftest doc-review-test-locate-prefers-section-file ()
  (doc-review-test--with-project doc-review-test--json
    (let* ((p (doc-review--project root))
           (loc (doc-review--locate (doc-review-test--thread 1 3 "sin una revisión formal suficiente" "x" "01-introduccion")
                                    (doc-review--source-files p))))
      (should (equal (file-name-nondirectory (car loc)) "01-introduccion.org"))
      (should (= (doc-review--line-at (car loc) (cadr loc)) 9)))))

;;; Untrusted text

(ert-deftest doc-review-test-sanitize ()
  (let ((evil (concat "B \e]0;pwned\a \e[31mrojo\e[0m \u202eevil\u2066x\u2069\r\nok\tfin \u009b" (string #x3fffe2))))
    (should (equal (doc-review--sanitize evil) "B ]0;pwned [31mrojo[0m evilx\nok\tfin "))
    (should (equal (doc-review--sanitize nil) ""))
    (should-not (string-match-p doc-review--unsafe-chars-regexp (doc-review--literal evil "  ")))
    (should-not (string-match-p "[\n\e]" (doc-review--clean-line evil)))))

;;; Configuration and HTTP plumbing

(ert-deftest doc-review-test-config-permissions ()
  (let ((f (doc-review-test--config "{\"url\": \"https://r.example/\", \"token\": \"t\"}" #o644)))
    (unwind-protect
        (let ((doc-review-config-file f))
          (should-error (doc-review--server) :type 'user-error)
          (set-file-modes f #o600)
          (should (equal (doc-review--server) '("https://r.example" . "t"))))
      (delete-file f))))

(ert-deftest doc-review-test-config-requires-https ()
  (dolist (case '(("http://r.example" . nil) ("ftp://r.example" . nil)
                  ("https://r.example" . t) ("http://localhost:8080" . t)
                  ("http://127.0.0.1:8099/" . t) ("http://[::1]:8080" . t)))
    (let ((f (doc-review-test--config (format "{\"url\": \"%s\", \"token\": \"t\"}" (car case)))))
      (unwind-protect
          (let ((doc-review-config-file f))
            (if (cdr case)
                (should (doc-review--server))
              (should-error (doc-review--server) :type 'user-error)))
        (delete-file f)))))

(ert-deftest doc-review-test-project-url-needs-its-own-token ()
  (let ((f (doc-review-test--config
            "{\"url\": \"https://r.example\", \"token\": \"t1\", \"servers\": {\"https://other.example\": \"t2\"}}")))
    (unwind-protect
        (let ((doc-review-config-file f))
          (should (equal (doc-review--server (doc-review--make-project :url "https://other.example/"))
                         '("https://other.example" . "t2")))
          (should (equal (doc-review--server (doc-review--make-project :url nil)) '("https://r.example" . "t1")))
          ;; A repository can't send the default token to another server.
          (should-error (doc-review--server (doc-review--make-project :url "https://evil.example")) :type 'user-error)
          (should-error (doc-review--server (doc-review--make-project :url "http://evil.example")) :type 'user-error))
      (delete-file f))))

(ert-deftest doc-review-test-async-fetch-reports-http-errors ()
  (let* ((p (doc-review--make-project :root "/tmp/p/" :document "thesis"))
         (doc-review--cache (make-hash-table :test #'equal))
         (doc-review--fetching (list "/tmp/p/"))
         messages)
    (cl-letf (((symbol-function 'message)
               (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
      (with-temp-buffer
        (insert "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"error\": \"Invalid token.\"}")
        (setq-local url-http-response-status 401)
        (doc-review--fetch-async-done p '(:error (error http 401))))
      (should-not doc-review--fetching)
      (should (null (doc-review--cached-threads p)))
      (should (string-match-p "could not be fetched: Invalid token" (car messages)))
      (with-temp-buffer
        (doc-review--fetch-async-done p '(:error (file-error "make client process failed" "Connection refused"))))
      (should (string-match-p "Connection refused" (car messages)))
      (with-temp-buffer
        (insert "HTTP/1.1 200 OK\r\n\r\n{\"threads\": [{\"id\": 3}]}")
        (setq-local url-http-response-status 200)
        (doc-review--fetch-async-done p nil))
      (should (equal (alist-get 'id (car (doc-review--cached-threads p))) 3)))))

(ert-deftest doc-review-test-handle-response ()
  (should (equal (doc-review--handle-response 200 "{\"a\": [1, null]}") '((a 1 nil))))
  (let ((err (should-error (doc-review--handle-response 403 "{\"error\": \"Only the owner\"}") :type 'user-error)))
    (should (string-match-p "Only the owner" (cadr err)))))

(ert-deftest doc-review-test-multipart ()
  (let* ((pdf (make-temp-file "dr" nil ".pdf"))
         (bytes (unibyte-string ?% ?P ?D ?F ?- #xff #x00 #xe2)))
    (unwind-protect
        (progn
          (with-temp-file pdf (set-buffer-multibyte nil) (insert bytes))
          (let ((body (doc-review--multipart "BB" `(("pdf" :file ,pdf :type "application/pdf")
                                                    ("progress" :data "{\"t\":\"ñ\"}" :filename "progress.json" :type "application/json")
                                                    ("note" . "Atendí los comentarios")))))
            (should-not (multibyte-string-p body))
            (should (string-search (concat "\r\n\r\n" bytes "\r\n--BB\r\n") body))
            (should (string-search "filename=\"progress.json\"" body))
            (should (string-search (encode-coding-string "{\"t\":\"ñ\"}" 'utf-8) body))
            (should (string-search (encode-coding-string "Atendí los comentarios" 'utf-8) body))
            (should (string-suffix-p "--BB--\r\n" body))))
      (delete-file pdf))))

(ert-deftest doc-review-test-headers ()
  (let* ((doc-review-language 'es)
         (h (doc-review--headers (decode-coding-string "dr_owner_x" 'utf-8) "application/json")))
    (should (equal (cdr (assoc "Authorization" h)) "Bearer dr_owner_x"))
    (should (equal (cdr (assoc "Accept-Language" h)) "es"))
    (should (cl-every (lambda (x) (not (multibyte-string-p (cdr x)))) h))))

;;; Messages

(ert-deftest doc-review-test-messages-complete ()
  (let ((en (alist-get 'en doc-review--messages))
        (es (alist-get 'es doc-review--messages))
        (specs (lambda (s) (let ((n 0) (i 0))
                             (while (string-match "%[sd]" s i) (setq n (1+ n) i (match-end 0)))
                             n))))
    (should (equal (sort (mapcar #'car en) #'string<) (sort (mapcar #'car es) #'string<)))
    (dolist (m en)
      (should (equal (cons (car m) (funcall specs (cdr m)))
                     (cons (car m) (funcall specs (alist-get (car m) es))))))
    (let ((doc-review-language 'es))
      (should (equal (doc-review--t 'replied 7) "Respuesta enviada al hilo #7")))
    (should (equal (doc-review--t 'replied 7) "Reply sent to thread #7"))))

;;; Commands with a mocked server

(ert-deftest doc-review-test-comments-buffer ()
  (doc-review-test--with-project doc-review-test--json
    (doc-review-test--mock
        `((threads . (,(doc-review-test--thread 1 3 "sin una revisión formal suficiente"
                                                "Cite una fuente.\n[[elisp:(kill-emacs)]]" "01-introduccion")
                      ,(doc-review-test--thread 2 9 "texto que ya no existe en las fuentes" "¿Y esto?" "01-introduccion"))))
      (let ((default-directory (expand-file-name "capitulos" root)))
        (doc-review-comments))
      (should (equal (cadr (car calls)) "/api/documents/thesis/threads?status=open"))
      (with-current-buffer "*doc-review: thesis*"
        (let ((text (buffer-string)))
          (should (derived-mode-p 'doc-review-comments-mode))
          (should (derived-mode-p 'org-mode))
          (should buffer-read-only)
          (should (string-match-p "^\\* Introducción$" text))
          (should (string-match-p "^\\*\\* p\\. 3 · v2 · Dra\\. Ana Torres Ruiz (Director)$" text))
          (should (string-match-p ":DOC_REVIEW_ID: 1" text))
          (should (string-match-p "Source: \\[\\[file:.*/capitulos/01-introduccion\\.org::9\\]\\[capitulos/01-introduccion\\.org:9\\]\\]" text))
          ;; Untrusted text is literal (fixed-width), never an active link.
          (should (string-match-p "^  : \\[\\[elisp:(kill-emacs)\\]\\]$" text))
          (should (string-match-p "^\\* Not located in the sources$" text))
          (should (string-match-p "Section file: \\[\\[file:.*/01-introduccion\\.org\\]" text))
          (should (< (string-search "Not located" text) (string-search "¿Y esto?" text))))
        (goto-char (point-min))
        (search-forward "Cite una fuente")
        (should (equal (doc-review--thread-at-point) 1))
        ;; Keys without evil.
        (should (eq (key-binding (kbd "r")) #'doc-review-reply))
        (should (eq (key-binding (kbd "x")) #'doc-review-resolve))
        (should (eq (key-binding (kbd "X")) #'doc-review-reopen))
        (should (eq (key-binding (kbd "g")) #'doc-review-refresh))
        (should (eq (key-binding (kbd "RET")) #'doc-review-visit-source))
        (should (eq (key-binding (kbd "q")) #'quit-window))
        ;; Next / previous thread; RET opens the source at the line.
        (goto-char (point-min))
        (doc-review-next-thread)
        (should (looking-at "\\*\\* p\\. 3"))
        (let (opened)
          (cl-letf (((symbol-function 'org-open-at-point) (lambda (&rest _) (setq opened (thing-at-point 'line)))))
            (doc-review-visit-source))
          (should (string-match-p "01-introduccion\\.org::9" opened)))
        (doc-review-next-thread)
        (should (looking-at "\\*\\* p\\. 9"))
        (doc-review-previous-thread)
        (should (looking-at "\\*\\* p\\. 3")))
      (kill-buffer "*doc-review: thesis*"))))

(ert-deftest doc-review-test-buffer-has-no-control-chars ()
  (doc-review-test--with-project doc-review-test--json
    (doc-review-test--mock
        `((threads . (,(doc-review-test--thread 1 3 "cita \u202eal revés" "Hola \e[2J\e]0;x\a fin"))))
      (let ((default-directory root)) (doc-review-comments))
      (with-current-buffer "*doc-review: thesis*"
        (should-not (string-match-p doc-review--unsafe-chars-regexp (buffer-string)))
        (should (string-match-p "Hola \\[2J\\]0;x fin" (buffer-string))))
      (kill-buffer "*doc-review: thesis*"))))

(ert-deftest doc-review-test-spanish-buffer ()
  (doc-review-test--with-project doc-review-test--json
    (let ((doc-review-language 'es))
      (doc-review-test--mock `((threads . (,(doc-review-test--thread 2 9 "nada" "x"))))
        (let ((default-directory root)) (doc-review-comments))
        (with-current-buffer "*doc-review: thesis*"
          (should (string-match-p "^\\* Sin ubicar en las fuentes$" (buffer-string)))
          (should (string-match-p "1 hilo(s) abiertos" (buffer-string))))
        (kill-buffer "*doc-review: thesis*")))))

(ert-deftest doc-review-test-reply-resolve-reopen ()
  (doc-review-test--with-project doc-review-test--json
    (let ((default-directory root))
      (doc-review-test--mock '((thread . ((id . 7))))
        (cl-letf (((symbol-function 'doc-review--after-change) #'ignore))
          (doc-review-reply 7 "Gracias, lo corrijo.")
          (doc-review-resolve 7)
          (doc-review-resolve 7 t)
          (doc-review-reopen 7))
        (setq calls (nreverse calls))
        (should (equal (nth 0 calls)
                       (list "POST" "/api/threads/7/comments"
                             (encode-coding-string "{\"body\":\"Gracias, lo corrijo.\"}" 'utf-8)
                             "application/json")))
        (should (equal (cadr (nth 1 calls)) "/api/threads/7/resolve"))
        (should (equal (cadr (nth 2 calls)) "/api/threads/7/reopen"))
        (should (equal (cadr (nth 3 calls)) "/api/threads/7/reopen"))
        (should-error (doc-review-reply 7 "   ") :type 'user-error)))))

(ert-deftest doc-review-test-publish ()
  (doc-review-test--with-project doc-review-test--json
    (with-temp-file (expand-file-name "tesis.pdf" root) (insert "%PDF-1.4 x"))
    (with-temp-file (expand-file-name "avance.json" root) (insert "{\"schema\":1}"))
    (doc-review-test--mock '((version . ((number . 3) (page_count . 120))) (url . "https://r.example/d/thesis/v/3"))
      (let ((default-directory (expand-file-name "capitulos" root)))
        (doc-review-publish "Nota"))
      (let ((call (car calls)))
        (should (equal (nth 0 call) "POST"))
        (should (equal (nth 1 call) "/api/documents/thesis/versions"))
        (should (string-prefix-p "multipart/form-data; boundary=doc-review-" (nth 3 call)))
        (should (string-search "%PDF-1.4 x" (nth 2 call)))
        (should (string-search "name=\"progress\"; filename=\"avance.json\"" (nth 2 call)))
        (should (string-search "{\"schema\":1}" (nth 2 call)))
        (should (string-search "name=\"note\"\r\n\r\nNota\r\n" (nth 2 call)))))))

(ert-deftest doc-review-test-publish-progress-command ()
  ;; "progress" as a command printing the JSON, and as {command, file}.
  (doc-review-test--with-project "{\"document\": \"d\", \"pdf\": \"tesis.pdf\", \"progress\": \"echo '{\\\"schema\\\":1}'\"}"
    (with-temp-file (expand-file-name "tesis.pdf" root) (insert "%PDF-1.4 x"))
    (doc-review-test--mock '((version . ((number . 1))))
      (let ((default-directory root)) (doc-review-publish ""))
      (should (string-search "filename=\"progress.json\"\r\nContent-Type: application/json\r\n\r\n{\"schema\":1}\n" (nth 2 (car calls))))))
  (doc-review-test--with-project "{\"document\": \"d\", \"pdf\": \"tesis.pdf\", \"progress\": {\"command\": \"echo '{}' > made.json\", \"file\": \"made.json\"}}"
    (with-temp-file (expand-file-name "tesis.pdf" root) (insert "%PDF-1.4 x"))
    (doc-review-test--mock '((version . ((number . 1))))
      (let ((default-directory root)) (doc-review-publish ""))
      (should (string-search "filename=\"made.json\"" (nth 2 (car calls))))))
  (doc-review-test--with-project "{\"document\": \"d\", \"pdf\": \"tesis.pdf\", \"progress\": \"false\"}"
    (with-temp-file (expand-file-name "tesis.pdf" root) (insert "%PDF-1.4 x"))
    (doc-review-test--mock nil
      (let ((default-directory root))
        (should-error (doc-review-publish "") :type 'user-error))
      (should-not calls))))

(ert-deftest doc-review-test-publish-without-pdf ()
  (doc-review-test--with-project doc-review-test--json
    (doc-review-test--mock nil
      (let ((default-directory root))
        (should-error (doc-review-publish "x") :type 'user-error))
      (should-not calls))))

(ert-deftest doc-review-test-list-documents-and-browser ()
  (doc-review-test--with-project doc-review-test--json
    (let* ((cfg (doc-review-test--config "{\"url\": \"https://r.example\", \"token\": \"t\"}"))
           (doc-review-config-file cfg)
           (default-directory root)
           browsed)
      (unwind-protect
          (cl-letf (((symbol-function 'browse-url) (lambda (u &rest _) (setq browsed u))))
            (doc-review-test--mock '((documents . (((slug . "thesis") (title . "Tesis\e[2J") (language . "es")
                                                    (archived . :false) (open_threads . 2)
                                                    (latest_version . ((number . 3)))))))
              (doc-review-list-documents)
              (with-current-buffer "*doc-review documents*"
                (should (string-match-p "thesis +Tesis\\[2J +es +v3 +2 +active" (buffer-string)))
                (goto-char (point-min))
                (doc-review-documents-open)
                (should (equal browsed "https://r.example/d/thesis"))
                (kill-buffer)))
            (should (equal (doc-review-open-in-browser) "https://r.example/d/thesis"))
            (should (equal (doc-review-open-in-browser t) "https://r.example/d/thesis/manage")))
        (delete-file cfg)))))

;;; Keys

(ert-deftest doc-review-test-command-map-and-prefix ()
  (should (eq (lookup-key doc-review-command-map (kbd "p")) #'doc-review-publish))
  (should (eq (lookup-key doc-review-command-map (kbd "c")) #'doc-review-comments))
  (should (eq (lookup-key doc-review-command-map (kbd "l")) #'doc-review-list-documents))
  (should (eq (lookup-key doc-review-command-map (kbd "b")) #'doc-review-open-in-browser))
  (let ((old doc-review-keymap-prefix))
    (unwind-protect
        (progn
          (customize-set-variable 'doc-review-keymap-prefix "C-c d")
          (should (eq (lookup-key global-map (kbd "C-c d")) 'doc-review-command-map))
          (customize-set-variable 'doc-review-keymap-prefix "C-c q")
          (should (eq (lookup-key global-map (kbd "C-c q")) 'doc-review-command-map))
          (should-not (eq (lookup-key global-map (kbd "C-c d")) 'doc-review-command-map))
          (customize-set-variable 'doc-review-keymap-prefix nil)
          (should-not (eq (lookup-key global-map (kbd "C-c q")) 'doc-review-command-map)))
      (customize-set-variable 'doc-review-keymap-prefix old))))

(ert-deftest doc-review-test-evil-keys-are-buffer-local ()
  ;; Without evil, `doc-review--setup-evil' binds nothing; with a fake
  ;; `evil-local-set-key', every key goes to the normal and motion states.
  (let (bound)
    (cl-letf (((symbol-function 'evil-local-set-key)
               (lambda (state key def) (push (list state (key-description key) def) bound))))
      (doc-review--setup-evil))
    (should (member '(normal "g r" doc-review-refresh) bound))
    (should (member '(motion "] ]" doc-review-next-thread) bound))
    (should (member '(normal "x" doc-review-resolve) bound))
    (should (= (length bound) (* 2 (length doc-review--evil-keys))))))

(ert-deftest doc-review-test-evil-org-does-not-shadow ()
  ;; With the real evil and evil-org on the load path (make test-emacs EVIL=…).
  (skip-unless (and (require 'evil nil t) (require 'evil-org nil t)))
  (evil-mode 1)
  (unwind-protect
      (doc-review-test--with-project doc-review-test--json
        (add-hook 'org-mode-hook #'evil-org-mode)
        (unwind-protect
            (doc-review-test--mock `((threads . (,(doc-review-test--thread 1 3 "sin una revisión formal suficiente" "x" "01-introduccion"))))
              (let ((default-directory root)) (doc-review-comments))
              (with-current-buffer "*doc-review: thesis*"
                (should (bound-and-true-p evil-org-mode))
                (evil-normal-state)
                (should (eq (key-binding (kbd "x")) #'doc-review-resolve))
                (should (eq (key-binding (kbd "r")) #'doc-review-reply))
                (should (eq (key-binding (kbd "o")) #'doc-review-open-in-browser))
                (should (eq (key-binding (kbd "gr")) #'doc-review-refresh))
                (should (eq (key-binding (kbd "gg")) #'evil-goto-first-line))
                (should (eq (key-binding (kbd "]]")) #'doc-review-next-thread))
                (kill-buffer)))
          (remove-hook 'org-mode-hook #'evil-org-mode)))
    (evil-mode -1)))

;;; Flymake

(ert-deftest doc-review-test-flymake-diagnostics ()
  (with-temp-buffer
    (insert doc-review-test--chapter)
    (org-mode)
    (let* ((threads (list (doc-review-test--thread 5 3 "sin una revisión formal suficiente" "Cite una fuente.")
                          (doc-review-test--thread 6 3 "no está en este archivo para nada" "x")))
           (diags (doc-review--buffer-diagnostics threads)))
      (should (= (length diags) 1))
      (let ((d (car diags)))
        (should (eq (flymake-diagnostic-type d) :note))
        (should (equal (flymake-diagnostic-data d) 5))
        (should (equal (buffer-substring (flymake-diagnostic-beg d) (flymake-diagnostic-end d))
                       "sin una revisión\nformal suficiente"))
        (should (string-match-p "Dra\\. Ana Torres Ruiz (Director) (v2 p\\. 3): Cite una fuente\\."
                                (flymake-diagnostic-text d)))))))

(ert-deftest doc-review-test-flymake-backend-uses-project-cache ()
  (doc-review-test--with-project doc-review-test--json
    (with-temp-buffer
      (insert doc-review-test--chapter)
      (setq-local doc-review--mode-project (doc-review--project root))
      (let (reported)
        ;; Not fetched yet (and no network in batch): nothing.
        (doc-review-flymake (lambda (diags &rest _) (setq reported diags)))
        (should-not reported)
        (puthash root (list (doc-review-test--thread 5 3 "sin una revisión formal suficiente" "x")) doc-review--cache)
        (doc-review-flymake (lambda (diags &rest _) (setq reported diags)))
        (should (= (length reported) 1))))))

(ert-deftest doc-review-test-maybe-enable ()
  (doc-review-test--with-project doc-review-test--json
    (let* ((cfg (doc-review-test--config "{\"url\": \"https://r.example\", \"token\": \"t\"}"))
           (doc-review-config-file cfg))
      (unwind-protect
          (progn
            (with-current-buffer (find-file-noselect (expand-file-name "capitulos/02-marco.org" root))
              (doc-review-maybe-enable)
              (should doc-review-mode)
              (should (equal (doc-review-project-root doc-review--mode-project) root))
              (kill-buffer))
            (with-temp-file (expand-file-name "notes.org" root) (insert "x"))
            (with-current-buffer (find-file-noselect (expand-file-name "notes.org" root))
              (doc-review-maybe-enable)
              (should-not doc-review-mode)
              (kill-buffer)))
        (delete-file cfg)))))

(provide 'doc-review-test)
;;; doc-review-test.el ends here
