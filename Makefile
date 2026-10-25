# Convenience targets; pnpm scripts do the same.
EMACS ?= emacs
# Extra load-path directories for the Emacs tests, e.g. to run the evil test:
#   make test-emacs EMACS_LOAD_PATH="$HOME/.config/emacs/.local/straight/build-31.1/{evil,evil-org,goto-chg}"
EMACS_LOAD_PATH ?=
LOAD = -L emacs $(foreach d,$(EMACS_LOAD_PATH),-L $(d))

.PHONY: test test-emacs build smoke

test:
	pnpm typecheck && pnpm test

test-emacs:
	$(EMACS) -Q --batch $(LOAD) -f batch-byte-compile emacs/doc-review.el && rm -f emacs/doc-review.elc
	$(EMACS) -Q --batch $(LOAD) -l emacs/test/doc-review-test.el -f ert-run-tests-batch-and-exit

build:
	pnpm build

smoke: build
	scripts/smoke.sh
