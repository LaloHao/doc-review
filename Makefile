# Convenience targets; pnpm scripts do the same.
EMACS ?= emacs

.PHONY: test test-emacs build

test:
	pnpm typecheck && pnpm test

test-emacs:
	$(EMACS) -Q --batch -L emacs -f batch-byte-compile emacs/doc-review.el && rm -f emacs/doc-review.elc
	$(EMACS) -Q --batch -L emacs -l emacs/test/doc-review-test.el -f ert-run-tests-batch-and-exit

build:
	pnpm build
