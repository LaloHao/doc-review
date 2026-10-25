;;; doc-review-test.el --- ERT tests for doc-review.el -*- lexical-binding: t; -*-

;; Run: emacs -Q --batch -L emacs -l emacs/test/doc-review-test.el -f ert-run-tests-batch-and-exit
;; HTTP is mocked: no test talks to a server.

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
Un \\gls{LLM} /local/ procesa los datos de viajes sin que salgan de la organización.
")

(defmacro doc-review-test--with-thesis (&rest body)
  "Run BODY with `root' bound to a temporary thesis directory."
  (declare (indent 0))
  `(let* ((root (file-name-as-directory (make-temp-file "doc-review-test" t)))
          (doc-review--index-cache (make-hash-table :test #'equal)))
     (unwind-protect
         (progn
           (make-directory (expand-file-name "capitulos" root))
           (with-temp-file (expand-file-name "tesis.org" root)
             (insert "#+TITLE: Tesis\n#+INCLUDE: \"capitulos/01-introduccion.org\" :minlevel 1\n"))
           (with-temp-file (expand-file-name "capitulos/01-introduccion.org" root)
             (insert doc-review-test--chapter))
           (with-temp-file (expand-file-name "capitulos/02-marco.org" root)
             (insert "* Marco teórico\n\nUna ruta de transporte público es una secuencia de paradas.\n"))
           ,@body)
       (delete-directory root t))))

(defun doc-review-test--thread (id page quote body &optional chapter)
  "A thread alist as the server returns it."
  `((id . ,id) (version . 2) (page . ,page) (anchor . "text") (quote . ,quote)
    (status . "open") (url . ,(format "https://r.example/v/2#hilo-%d" id))
    (section . ,(and chapter `((id . ,chapter) (title . "Introducción"))))
    (author . ((kind . "director") (name . "Dra. Ana Torres Ruiz")))
    (comments . (((id . ,(* 10 id)) (author . ((kind . "director") (name . "Dra. Ana Torres Ruiz")))
                  (body . ,body) (created_at . "2026-10-24T18:00:00Z") (edited_at . nil) (deleted . :false))))))

;;; Normalization and anchoring

(ert-deftest doc-review-test-normalize-quote ()
  (should (equal (doc-review--normalize-quote "Una revi-\nsión  ﬁnal [12] del  ﬂujo, [3, 4–6]")
                 "unarevisiónfinaldelflujo"))
  (should (equal (doc-review--normalize-quote "Post-Mortem­") "postmortem")))

(ert-deftest doc-review-test-locate-exact-across-markup ()
  (let* ((index (doc-review--index-string doc-review-test--chapter))
         ;; As pdf.js gives it: line break, hyphenation, the citation as [1].
         (q (doc-review--normalize-quote
             "se integra sin una revi- sión formal suficiente [1] y que empieza"))
         (hit (doc-review--locate-in-index q index)))
    (should hit)
    (should (equal (substring doc-review-test--chapter (1- (car hit)) (1- (cdr hit)))
                   "se integra sin una revisión\nformal suficiente [cite:@example2024routes] y que empieza"))))

(ert-deftest doc-review-test-masks-latex-and-comments ()
  (let ((index (doc-review--index-string doc-review-test--chapter)))
    (should (doc-review--locate-in-index
             (doc-review--normalize-quote "Un LLM local procesa los datos de viajes") index))
    (should-not (string-search "comentario" (car index)))
    (should-not (string-search "customid" (car index)))
    (should-not (string-search "cite" (car index)))))

(ert-deftest doc-review-test-locate-fuzzy-after-edit ()
  ;; The author edited the middle of the sentence after compiling the PDF.
  (let* ((index (doc-review--index-string doc-review-test--chapter))
         (q (doc-review--normalize-quote
             "La analítica de datos de viajes se incorpora muy rápido al planificación del transporte público. Esto genera un modelo")))
    (should (doc-review--locate-in-index q index))))

(ert-deftest doc-review-test-locate-glossary-expansion ()
  ;; The PDF expands \\gls{LLM} on first use; the source only has the macro.
  (let* ((index (doc-review--index-string doc-review-test--chapter))
         (q (doc-review--normalize-quote
             "Un modelo de lenguaje de gran tamaño (LLM) local procesa los datos de viajes sin que salgan de la organización."))
         (hit (doc-review--locate-in-index q index)))
    (should hit)
    (should (string-match-p "procesa los datos de viajes sin que salgan de la organización"
                            (substring doc-review-test--chapter (1- (car hit)) (1- (cdr hit)))))))

(ert-deftest doc-review-test-unrelated-quote-not-anchored ()
  (let ((index (doc-review--index-string doc-review-test--chapter)))
    (should-not (doc-review--locate-in-index
                 (doc-review--normalize-quote "Las redes neuronales convolucionales clasifican imágenes médicas.")
                 index))))

(ert-deftest doc-review-test-short-quotes-not-anchored ()
  (let ((index (doc-review--index-string doc-review-test--chapter)))
    (should-not (doc-review--locate-in-index (doc-review--normalize-quote "Un") index))))

(ert-deftest doc-review-test-locate-prefers-chapter-file ()
  (doc-review-test--with-thesis
    (let* ((files (doc-review--org-files root))
           (loc (doc-review--locate
                 (doc-review-test--thread 1 3 "sin una revisión formal suficiente" "x" "01-introduccion")
                 files)))
      (should (equal (file-name-nondirectory (car loc)) "01-introduccion.org"))
      (should (= (doc-review--line-at (car loc) (cadr loc)) 9)))))

(ert-deftest doc-review-test-sanitize ()
  (let ((evil (concat "B \e]0;pwned\a \e[31mrojo\e[0m \u202eevil\u2066x\u2069\r\nok\tfin \u009b" (string #x3fffe2))))
    (should (equal (doc-review--sanitize evil) "B ]0;pwned [31mrojo[0m evilx\nok\tfin "))
    (should (equal (doc-review--sanitize nil) ""))
    (should-not (string-match-p doc-review--unsafe-chars-regexp
                                (doc-review--literal evil "  ")))
    (should-not (string-match-p "[\n\e]" (doc-review--clean-heading evil)))))

(ert-deftest doc-review-test-buffer-has-no-control-chars ()
  (doc-review-test--with-thesis
    (doc-review-test--mock
        `((threads . (,(doc-review-test--thread 1 3 "cita \u202eal revés" "Hola \e[2J\e]0;x\a fin"))))
      (let ((default-directory root))
        (doc-review-comentarios))
      (with-current-buffer doc-review-buffer-name
        (should-not (string-match-p doc-review--unsafe-chars-regexp (buffer-string)))
        (should (string-match-p "Hola \\[2J\\]0;x fin" (buffer-string))))
      (kill-buffer doc-review-buffer-name))))

;;; Config and HTTP plumbing

(ert-deftest doc-review-test-config-permissions ()
  (let ((f (make-temp-file "rt-config" nil ".json" "{\"url\": \"https://r.example/\", \"token\": \"t\"}")))
    (unwind-protect
        (let ((doc-review-config-file f))
          (set-file-modes f #o644)
          (should-error (doc-review--config) :type 'user-error)
          (set-file-modes f #o600)
          (should (equal (doc-review--config) '("https://r.example" . "t"))))
      (delete-file f))))

(ert-deftest doc-review-test-config-requires-https ()
  (dolist (case '(("http://r.example" . nil) ("ftp://r.example" . nil)
                  ("https://r.example" . t) ("http://localhost:8080" . t)
                  ("http://127.0.0.1:8099/" . t) ("http://[::1]:8080" . t)))
    (let ((f (make-temp-file "rt-config" nil ".json"
                             (format "{\"url\": \"%s\", \"token\": \"t\"}" (car case)))))
      (unwind-protect
          (let ((doc-review-config-file f))
            (set-file-modes f #o600)
            (if (cdr case)
                (should (doc-review--config))
              (should-error (doc-review--config) :type 'user-error)))
        (delete-file f)))))

(ert-deftest doc-review-test-async-fetch-reports-http-errors ()
  (let ((doc-review--fetching t) (doc-review--fetched nil)
        (doc-review--threads '(old)) messages)
    (cl-letf (((symbol-function 'message)
               (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
      (with-temp-buffer
        (insert "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"error\": \"Token no v\u00e1lido.\"}")
        (setq-local url-http-response-status 401)
        (doc-review--fetch-async-done '(:error (error http 401))))
      (should-not doc-review--fetching)
      (should doc-review--fetched)
      (should-not doc-review--threads)
      (should (string-match-p "no se pudieron descargar los comentarios: Token no válido" (car messages)))
      ;; Connection refused: no HTTP status at all.
      (with-temp-buffer
        (doc-review--fetch-async-done '(:error (file-error "make client process failed" "Connection refused"))))
      (should (string-match-p "Connection refused" (car messages))))
    ;; Success fills the cache.
    (let ((doc-review--fetched nil))
      (with-temp-buffer
        (insert "HTTP/1.1 200 OK\r\n\r\n{\"threads\": [{\"id\": 3}]}")
        (setq-local url-http-response-status 200)
        (doc-review--fetch-async-done nil))
      (should doc-review--fetched)
      (should (equal (alist-get 'id (car doc-review--threads)) 3)))))

(ert-deftest doc-review-test-handle-response ()
  (should (equal (doc-review--handle-response 200 "{\"a\": [1, null]}") '((a 1 nil))))
  (let ((err (should-error (doc-review--handle-response 403 "{\"error\": \"Solo el autor\"}")
                           :type 'user-error)))
    (should (string-match-p "Solo el autor" (cadr err)))))

(ert-deftest doc-review-test-multipart ()
  (let* ((pdf (make-temp-file "rt" nil ".pdf"))
         (bytes (unibyte-string ?% ?P ?D ?F ?- #xff #x00 #xe2)))
    (unwind-protect
        (progn
          (with-temp-file pdf (set-buffer-multibyte nil) (insert bytes))
          (let ((body (doc-review--multipart "BB" `(("pdf" :file ,pdf :type "application/pdf")
                                                       ("note" . "Atendí los comentarios")))))
            (should-not (multibyte-string-p body))
            (should (string-search (concat "\r\n\r\n" bytes "\r\n--BB\r\n") body))
            (should (string-search (encode-coding-string "Atendí los comentarios" 'utf-8) body))
            (should (string-suffix-p "--BB--\r\n" body))))
      (delete-file pdf))))

(ert-deftest doc-review-test-headers-unibyte ()
  ;; Tokens come from JSON (multibyte strings); url.el needs unibyte headers.
  (let ((h (doc-review--headers (decode-coding-string "dr_owner_x" 'utf-8) "application/json")))
    (should (equal (cdr (assoc "Authorization" h)) "Bearer dr_owner_x"))
    (should (cl-every (lambda (x) (not (multibyte-string-p (cdr x)))) h))))

;;; Commands with a mocked server

(defmacro doc-review-test--mock (response &rest body)
  "Run BODY with `doc-review--request' returning RESPONSE; bind `calls'."
  (declare (indent 1))
  `(let ((calls nil))
     (cl-letf (((symbol-function 'doc-review--request)
                (lambda (method path &optional data type)
                  (push (list method path data type) calls)
                  ,response)))
       ,@body)))

(ert-deftest doc-review-test-comentarios-buffer ()
  (doc-review-test--with-thesis
    (doc-review-test--mock
        `((threads . (,(doc-review-test--thread 1 3 "sin una revisión formal suficiente"
                                                    "Cite una fuente.\n[[elisp:(kill-emacs)]]" "01-introduccion")
                      ,(doc-review-test--thread 2 9 "texto que ya no existe en las fuentes" "¿Y esto?" "01-introduccion"))))
      (let ((default-directory (expand-file-name "capitulos" root)))
        (doc-review-comentarios))
      (should (equal (cadr (car calls)) "/api/threads?status=open"))
      (with-current-buffer doc-review-buffer-name
        (let ((text (buffer-string)))
          (should (derived-mode-p 'org-mode))
          (should (string-match-p "^\\* Introducción$" text))
          (should (string-match-p "^\\*\\* p\\. 3 · v2 · Dra\\. Ana Torres Ruiz$" text))
          (should (string-match-p ":DOC_REVIEW_ID: 1" text))
          (should (string-match-p "Fuente: \\[\\[file:.*/capitulos/01-introduccion\\.org::9\\]\\[capitulos/01-introduccion\\.org:9\\]\\]" text))
          ;; Untrusted text is literal (fixed-width), never an active link.
          (should (string-match-p "^  : \\[\\[elisp:(kill-emacs)\\]\\]$" text))
          (should (string-match-p "^\\* Sin ubicar en el código fuente$" text))
          (should (string-match-p "Capítulo: \\[\\[file:.*/01-introduccion\\.org\\]" text))
          (should (< (string-search "Sin ubicar" text) (string-search "¿Y esto?" text))))
        (goto-char (point-min))
        (search-forward "Cite una fuente")
        (should (equal (doc-review--thread-at-point) 1)))
      (kill-buffer doc-review-buffer-name))))

(ert-deftest doc-review-test-responder-y-resolver ()
  (doc-review-test--mock '((thread . ((id . 7))))
    (cl-letf (((symbol-function 'doc-review--after-change) #'ignore))
      (doc-review-responder 7 "Gracias, lo corrijo.")
      (doc-review-resolver 7)
      (doc-review-resolver 7 t))
    (setq calls (nreverse calls))
    (should (equal (nth 0 calls)
                   (list "POST" "/api/threads/7/comments"
                         (encode-coding-string "{\"body\":\"Gracias, lo corrijo.\"}" 'utf-8)
                         "application/json")))
    (should (equal (cadr (nth 1 calls)) "/api/threads/7/resolve"))
    (should (equal (cadr (nth 2 calls)) "/api/threads/7/reopen"))
    (should-error (doc-review-responder 7 "   ") :type 'user-error)))

(ert-deftest doc-review-test-publicar ()
  (doc-review-test--with-thesis
    (with-temp-file (expand-file-name "tesis.pdf" root) (insert "%PDF-1.4 x"))
    (with-temp-file (expand-file-name "avance.json" root) (insert "{\"schema\":1}"))
    (doc-review-test--mock '((version . ((number . 3) (page_count . 120))) (url . "https://r.example/v/3"))
      (let ((default-directory (expand-file-name "capitulos" root)))
        (doc-review-publicar "Nota"))
      (let ((call (car calls)))
        (should (equal (nth 0 call) "POST"))
        (should (equal (nth 1 call) "/api/versions"))
        (should (string-prefix-p "multipart/form-data; boundary=doc-review-" (nth 3 call)))
        (should (string-search "%PDF-1.4 x" (nth 2 call)))
        (should (string-search "{\"schema\":1}" (nth 2 call)))
        (should (string-search "name=\"note\"\r\n\r\nNota\r\n" (nth 2 call)))))))

(ert-deftest doc-review-test-publicar-sin-pdf ()
  (doc-review-test--with-thesis
    (doc-review-test--mock nil
      (let ((default-directory root))
        (should-error (doc-review-publicar "x") :type 'user-error))
      (should-not calls))))

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
        (should (string-match-p "Dra\\. Ana Torres Ruiz (v2 p\\. 3): Cite una fuente\\."
                                (flymake-diagnostic-text d)))))))

(ert-deftest doc-review-test-flymake-backend-uses-cache ()
  (with-temp-buffer
    (insert doc-review-test--chapter)
    (let ((doc-review--fetched t)
          (doc-review--threads (list (doc-review-test--thread 5 3 "sin una revisión formal suficiente" "x")))
          reported)
      (doc-review-flymake (lambda (diags &rest _) (setq reported diags)))
      (should (= (length reported) 1)))))

(provide 'doc-review-test)
;;; doc-review-test.el ends here
