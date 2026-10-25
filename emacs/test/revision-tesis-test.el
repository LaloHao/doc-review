;;; revision-tesis-test.el --- ERT tests for revision-tesis.el -*- lexical-binding: t; -*-

;; Run: emacs -Q --batch -L emacs -l emacs/test/revision-tesis-test.el -f ert-run-tests-batch-and-exit
;; HTTP is mocked: no test talks to a server.

;;; Code:

(require 'ert)
(require 'cl-lib)
(require 'revision-tesis)

(defconst revision-tesis-test--chapter
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

(defmacro revision-tesis-test--with-thesis (&rest body)
  "Run BODY with `root' bound to a temporary thesis directory."
  (declare (indent 0))
  `(let* ((root (file-name-as-directory (make-temp-file "revision-tesis-test" t)))
          (revision-tesis--index-cache (make-hash-table :test #'equal)))
     (unwind-protect
         (progn
           (make-directory (expand-file-name "capitulos" root))
           (with-temp-file (expand-file-name "tesis.org" root)
             (insert "#+TITLE: Tesis\n#+INCLUDE: \"capitulos/01-introduccion.org\" :minlevel 1\n"))
           (with-temp-file (expand-file-name "capitulos/01-introduccion.org" root)
             (insert revision-tesis-test--chapter))
           (with-temp-file (expand-file-name "capitulos/02-marco.org" root)
             (insert "* Marco teórico\n\nUna ruta de transporte público es una secuencia de paradas.\n"))
           ,@body)
       (delete-directory root t))))

(defun revision-tesis-test--thread (id page quote body &optional chapter)
  "A thread alist as the server returns it."
  `((id . ,id) (version . 2) (page . ,page) (anchor . "text") (quote . ,quote)
    (status . "open") (url . ,(format "https://r.example/v/2#hilo-%d" id))
    (chapter . ,(and chapter `((id . ,chapter) (title . "Introducción"))))
    (author . ((kind . "director") (name . "Dra. Ana Torres Ruiz")))
    (comments . (((id . ,(* 10 id)) (author . ((kind . "director") (name . "Dra. Ana Torres Ruiz")))
                  (body . ,body) (created_at . "2026-10-24T18:00:00Z") (edited_at . nil) (deleted . :false))))))

;;; Normalization and anchoring

(ert-deftest revision-tesis-test-normalize-quote ()
  (should (equal (revision-tesis--normalize-quote "Una revi-\nsión  ﬁnal [12] del  ﬂujo, [3, 4–6]")
                 "unarevisiónfinaldelflujo"))
  (should (equal (revision-tesis--normalize-quote "Post-Mortem­") "postmortem")))

(ert-deftest revision-tesis-test-locate-exact-across-markup ()
  (let* ((index (revision-tesis--index-string revision-tesis-test--chapter))
         ;; As pdf.js gives it: line break, hyphenation, the citation as [1].
         (q (revision-tesis--normalize-quote
             "se integra sin una revi- sión formal suficiente [1] y que empieza"))
         (hit (revision-tesis--locate-in-index q index)))
    (should hit)
    (should (equal (substring revision-tesis-test--chapter (1- (car hit)) (1- (cdr hit)))
                   "se integra sin una revisión\nformal suficiente [cite:@example2024routes] y que empieza"))))

(ert-deftest revision-tesis-test-masks-latex-and-comments ()
  (let ((index (revision-tesis--index-string revision-tesis-test--chapter)))
    (should (revision-tesis--locate-in-index
             (revision-tesis--normalize-quote "Un LLM local procesa los datos de viajes") index))
    (should-not (string-search "comentario" (car index)))
    (should-not (string-search "customid" (car index)))
    (should-not (string-search "cite" (car index)))))

(ert-deftest revision-tesis-test-locate-fuzzy-after-edit ()
  ;; The author edited the middle of the sentence after compiling the PDF.
  (let* ((index (revision-tesis--index-string revision-tesis-test--chapter))
         (q (revision-tesis--normalize-quote
             "La analítica de datos de viajes se incorpora muy rápido al planificación del transporte público. Esto genera un modelo")))
    (should (revision-tesis--locate-in-index q index))))

(ert-deftest revision-tesis-test-short-quotes-not-anchored ()
  (let ((index (revision-tesis--index-string revision-tesis-test--chapter)))
    (should-not (revision-tesis--locate-in-index (revision-tesis--normalize-quote "Un") index))))

(ert-deftest revision-tesis-test-locate-prefers-chapter-file ()
  (revision-tesis-test--with-thesis
    (let* ((files (revision-tesis--org-files root))
           (loc (revision-tesis--locate
                 (revision-tesis-test--thread 1 3 "sin una revisión formal suficiente" "x" "01-introduccion")
                 files)))
      (should (equal (file-name-nondirectory (car loc)) "01-introduccion.org"))
      (should (= (revision-tesis--line-at (car loc) (cadr loc)) 9)))))

;;; Config and HTTP plumbing

(ert-deftest revision-tesis-test-config-permissions ()
  (let ((f (make-temp-file "rt-config" nil ".json" "{\"url\": \"https://r.example/\", \"token\": \"t\"}")))
    (unwind-protect
        (let ((revision-tesis-config-file f))
          (set-file-modes f #o644)
          (should-error (revision-tesis--config) :type 'user-error)
          (set-file-modes f #o600)
          (should (equal (revision-tesis--config) '("https://r.example" . "t"))))
      (delete-file f))))

(ert-deftest revision-tesis-test-handle-response ()
  (should (equal (revision-tesis--handle-response 200 "{\"a\": [1, null]}") '((a 1 nil))))
  (let ((err (should-error (revision-tesis--handle-response 403 "{\"error\": \"Solo el autor\"}")
                           :type 'user-error)))
    (should (string-match-p "Solo el autor" (cadr err)))))

(ert-deftest revision-tesis-test-multipart ()
  (let* ((pdf (make-temp-file "rt" nil ".pdf"))
         (bytes (unibyte-string ?% ?P ?D ?F ?- #xff #x00 #xe2)))
    (unwind-protect
        (progn
          (with-temp-file pdf (set-buffer-multibyte nil) (insert bytes))
          (let ((body (revision-tesis--multipart "BB" `(("pdf" :file ,pdf :type "application/pdf")
                                                       ("note" . "Atendí los comentarios")))))
            (should-not (multibyte-string-p body))
            (should (string-search (concat "\r\n\r\n" bytes "\r\n--BB\r\n") body))
            (should (string-search (encode-coding-string "Atendí los comentarios" 'utf-8) body))
            (should (string-suffix-p "--BB--\r\n" body))))
      (delete-file pdf))))

;;; Commands with a mocked server

(defmacro revision-tesis-test--mock (response &rest body)
  "Run BODY with `revision-tesis--request' returning RESPONSE; bind `calls'."
  (declare (indent 1))
  `(let ((calls nil))
     (cl-letf (((symbol-function 'revision-tesis--request)
                (lambda (method path &optional data type)
                  (push (list method path data type) calls)
                  ,response)))
       ,@body)))

(ert-deftest revision-tesis-test-comentarios-buffer ()
  (revision-tesis-test--with-thesis
    (revision-tesis-test--mock
        `((threads . (,(revision-tesis-test--thread 1 3 "sin una revisión formal suficiente"
                                                    "Cite una fuente.\n[[elisp:(kill-emacs)]]" "01-introduccion")
                      ,(revision-tesis-test--thread 2 9 "texto que ya no existe en las fuentes" "¿Y esto?"))))
      (let ((default-directory (expand-file-name "capitulos" root)))
        (revision-tesis-comentarios))
      (should (equal (cadr (car calls)) "/api/threads?status=open"))
      (with-current-buffer revision-tesis-buffer-name
        (let ((text (buffer-string)))
          (should (derived-mode-p 'org-mode))
          (should (string-match-p "^\\* Introducción$" text))
          (should (string-match-p "^\\*\\* p\\. 3 · v2 · Dra\\. Ana Torres Ruiz$" text))
          (should (string-match-p ":REVISION_TESIS_ID: 1" text))
          (should (string-match-p "Fuente: \\[\\[file:.*/capitulos/01-introduccion\\.org::9\\]\\[capitulos/01-introduccion\\.org:9\\]\\]" text))
          ;; Untrusted text is literal (fixed-width), never an active link.
          (should (string-match-p "^  : \\[\\[elisp:(kill-emacs)\\]\\]$" text))
          (should (string-match-p "^\\* Sin ubicar en el código fuente$" text))
          (should (< (string-search "Sin ubicar" text) (string-search "¿Y esto?" text))))
        (goto-char (point-min))
        (search-forward "Cite una fuente")
        (should (equal (revision-tesis--thread-at-point) 1)))
      (kill-buffer revision-tesis-buffer-name))))

(ert-deftest revision-tesis-test-responder-y-resolver ()
  (revision-tesis-test--mock '((thread . ((id . 7))))
    (cl-letf (((symbol-function 'revision-tesis--after-change) #'ignore))
      (revision-tesis-responder 7 "Gracias, lo corrijo.")
      (revision-tesis-resolver 7)
      (revision-tesis-resolver 7 t))
    (setq calls (nreverse calls))
    (should (equal (nth 0 calls)
                   (list "POST" "/api/threads/7/comments"
                         (encode-coding-string "{\"body\":\"Gracias, lo corrijo.\"}" 'utf-8)
                         "application/json")))
    (should (equal (cadr (nth 1 calls)) "/api/threads/7/resolve"))
    (should (equal (cadr (nth 2 calls)) "/api/threads/7/reopen"))
    (should-error (revision-tesis-responder 7 "   ") :type 'user-error)))

(ert-deftest revision-tesis-test-publicar ()
  (revision-tesis-test--with-thesis
    (with-temp-file (expand-file-name "tesis.pdf" root) (insert "%PDF-1.4 x"))
    (with-temp-file (expand-file-name "avance.json" root) (insert "{\"schema\":1}"))
    (revision-tesis-test--mock '((version . ((number . 3) (page_count . 120))) (url . "https://r.example/v/3"))
      (let ((default-directory (expand-file-name "capitulos" root)))
        (revision-tesis-publicar "Nota"))
      (let ((call (car calls)))
        (should (equal (nth 0 call) "POST"))
        (should (equal (nth 1 call) "/api/versions"))
        (should (string-prefix-p "multipart/form-data; boundary=revision-tesis-" (nth 3 call)))
        (should (string-search "%PDF-1.4 x" (nth 2 call)))
        (should (string-search "{\"schema\":1}" (nth 2 call)))
        (should (string-search "name=\"note\"\r\n\r\nNota\r\n" (nth 2 call)))))))

(ert-deftest revision-tesis-test-publicar-sin-pdf ()
  (revision-tesis-test--with-thesis
    (revision-tesis-test--mock nil
      (let ((default-directory root))
        (should-error (revision-tesis-publicar "x") :type 'user-error))
      (should-not calls))))

;;; Flymake

(ert-deftest revision-tesis-test-flymake-diagnostics ()
  (with-temp-buffer
    (insert revision-tesis-test--chapter)
    (org-mode)
    (let* ((threads (list (revision-tesis-test--thread 5 3 "sin una revisión formal suficiente" "Cite una fuente.")
                          (revision-tesis-test--thread 6 3 "no está en este archivo para nada" "x")))
           (diags (revision-tesis--buffer-diagnostics threads)))
      (should (= (length diags) 1))
      (let ((d (car diags)))
        (should (eq (flymake-diagnostic-type d) :note))
        (should (equal (flymake-diagnostic-data d) 5))
        (should (equal (buffer-substring (flymake-diagnostic-beg d) (flymake-diagnostic-end d))
                       "sin una revisión\nformal suficiente"))
        (should (string-match-p "Dra\\. Ana Torres Ruiz (v2 p\\. 3): Cite una fuente\\."
                                (flymake-diagnostic-text d)))))))

(ert-deftest revision-tesis-test-flymake-backend-uses-cache ()
  (with-temp-buffer
    (insert revision-tesis-test--chapter)
    (let ((revision-tesis--fetched t)
          (revision-tesis--threads (list (revision-tesis-test--thread 5 3 "sin una revisión formal suficiente" "x")))
          reported)
      (revision-tesis-flymake (lambda (diags &rest _) (setq reported diags)))
      (should (= (length reported) 1)))))

(provide 'revision-tesis-test)
;;; revision-tesis-test.el ends here
