# whydiff development loop — test changes locally, before pushing.
#
#   make check              fast checks, no LLM, no plugin install (~20s)
#   make preview            assemble the reference example and open it
#   make fixtures           list the fixture projects
#   make run-synthetic      build a fixture and open Claude with THIS working tree
#   make report-synthetic   show the timing report of the last run there
#
# `run-*` loads the plugin with --plugin-dir, so the working tree is what runs:
# no commit, no push, no version bump. It also overrides an installed copy of
# whydiff for that session. Inside: `/whydiff HEAD~1..HEAD`, and `/reload-plugins`
# after editing agents/ or hooks/ (skills reload on their own).

PLUGIN_DIR := $(shell pwd)
FIXDIR     := $(PLUGIN_DIR)/.fixtures
EXAMPLE    := examples/rate-limit/review-map.json

.PHONY: help check coverage pdf-e2e preview fixtures clean-fixtures bump hooks
.DEFAULT_GOAL := help

help: ## show this help
	@grep -hE '^[a-z0-9%-]+:.*##' $(MAKEFILE_LIST) \
		| sed -e 's/:.*##[[:space:]]*/\t/' \
		| awk -F'\t' '{printf "  \033[1m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@$(MAKE) --no-print-directory fixtures

check: ## contract + viewer + manifest + version checks (no LLM)
	node scripts/validate.mjs $(EXAMPLE)
	node scripts/check-version.mjs
	npm test
	claude plugin validate . --strict

coverage: ## run the suite under c8 and print scripts/ coverage (fails below the floor)
	npm run coverage

pdf-e2e: ## end-to-end PDF comments: real Chromium print → annotate (needs app/ deps installed)
	node tests/pdf-comments.mjs

bump: ## bump version + open a CHANGELOG entry: make bump BUMP=minor [NOTE="…"]
	@test -n "$(BUMP)" || { echo 'usage: make bump BUMP=<patch|minor|major> [NOTE="…"]'; exit 1; }
	node scripts/version.mjs $(BUMP) $(if $(NOTE),--note,) $(if $(NOTE),"$(NOTE)",)

hooks: ## install the repo git hooks (version guard on push)
	git config core.hooksPath .githooks
	@echo "✓ core.hooksPath → .githooks"

preview: ## assemble the reference example and open it in a browser
	@mkdir -p $(FIXDIR)
	node scripts/assemble.mjs $(EXAMPLE) --out $(FIXDIR)/preview.html
	open $(FIXDIR)/preview.html

fixtures: ## list the fixture projects and what each one is for
	@node tests/fixtures/prepare.mjs --list

fixture-%: ## prepare fixture <name> in .fixtures/<name>
	@node tests/fixtures/prepare.mjs $*

run-%: fixture-% ## prepare fixture <name> and open Claude there with this working tree
	@echo ""
	@echo "→ in the session: /whydiff HEAD~1..HEAD"
	@echo ""
	@cd $(FIXDIR)/$* && claude --plugin-dir $(PLUGIN_DIR)

report-%: ## show the timing report from the last run against fixture <name>
	@node scripts/timing.mjs report --repo $(FIXDIR)/$*
	@cat $(FIXDIR)/$*/.whydiff/timing-report.md

map-%: ## open the HTML map produced by the last run against fixture <name>
	@open $$(ls -t $(FIXDIR)/$*/.whydiff/*.html | head -1)

serve-%: ## serve fixture <name>'s map with live Q&A (asks via `claude -p`)
	@echo "→ open the printed URL; the ask UI exists only on this served copy"
	@node scripts/serve.mjs $(FIXDIR)/$*/.whydiff/review-map.json --repo $(FIXDIR)/$*

clean-fixtures: ## remove all prepared fixtures
	rm -rf $(FIXDIR)
