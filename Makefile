.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

## help: list available targets
help:
	@echo "Countersign — make targets"
	@echo
	@grep -E '^## [a-zA-Z_-]+:' $(MAKEFILE_LIST) \
		| sed -e 's/## //' \
		| awk -F': ' '{ printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }'
	@echo
	@echo "First run:  make setup && make up && make check"

## setup: install dependencies, create .env, generate signing keys
setup: node_modules .env
	@pnpm exec tsx scripts/gen-keys.ts --write
	@echo "ready. next: make up"

node_modules: package.json pnpm-lock.yaml
	@pnpm install --frozen-lockfile
	@touch node_modules

.env:
	@cp .env.example .env
	@echo "created .env from .env.example — add your rzp_test_ credentials"

## up: start postgres and jaeger, wait until healthy
up:
	@docker compose up -d --wait
	@echo "postgres :5432   jaeger UI http://localhost:16686"

## down: stop containers, keep data
down:
	@docker compose down

# `down` deliberately keeps the volume, so restarting does not cost you your
# data. That also means POSTGRES_USER and POSTGRES_DB are only ever read on
# first initialisation — change either one and every later connection fails
# authentication against a database still holding the old role. `reset` is the
# way out, and it destroys the data.
## reset: recreate the database from empty (DESTROYS DATA)
reset:
	@docker compose down -v
	@docker compose up -d --wait
	@$(MAKE) --no-print-directory migrate

## migrate: apply pending migrations
migrate:
	@pnpm exec tsx scripts/migrate.ts

## clean: stop containers and delete the database volume
clean:
	@docker compose down -v

## dev: run the API with reload
dev:
	@pnpm exec tsx watch src/http/server.ts

## test: run unit tests
test:
	@pnpm exec vitest run --project unit

## test-integration: run integration tests (needs `make up`)
test-integration:
	@pnpm exec vitest run --project integration

## check: everything CI runs — lint, types, tests, secret scan
check: verify-make lint typecheck test scan-secrets

## lint: check formatting and lint rules
lint:
	@pnpm exec biome check .

## fix: apply formatting and safe lint fixes
fix:
	@pnpm exec biome check --write .

## typecheck: run tsc without emitting
typecheck:
	@pnpm exec tsc --noEmit

# A live key in a public hackathon repo moves real money. src/config.ts refuses
# to boot with one; this stops it reaching a commit in the first place.
#
# Matches key-SHAPED strings, not the prefix on its own — a scanner that fires
# on the documentation describing it (or on its own definition) is a scanner
# somebody disables within a day. Deliberate key-shaped fixtures carry an
# explicit `pragma: allow-live-key` marker, which is greppable in review.
## scan-secrets: fail if a live Razorpay key is in the tree or in history
scan-secrets:
	@./scripts/scan-secrets.sh --all

## vectors: regenerate the cryptographic test vectors (wire-format change)
vectors:
	@pnpm exec tsx scripts/gen-vectors.ts

## keys: print freshly generated signing keys without touching .env
keys:
	@pnpm exec tsx scripts/gen-keys.ts

## demo: eight rehearsed failures, live, under 20 seconds (needs `make up` for 6 and 8)
demo:
	@pnpm exec tsx scripts/rehearse.ts

## cli: single-file verifier, for handing to a judge on a USB stick
cli:
	@mkdir -p dist
	@pnpm exec esbuild src/cli/index.ts --bundle --platform=node --format=esm \
		--outfile=dist/countersign.mjs --banner:js="#!/usr/bin/env node"
	@chmod +x dist/countersign.mjs
	@echo "wrote dist/countersign.mjs"

.PHONY: help setup up down reset migrate clean dev test test-integration check lint fix typecheck scan-secrets vectors keys verify-make cli demo

# Guard against exactly that recurring: fail if any .PHONY target has no
# recipe. `make -pq` prints the database; a real target reports its commands.
## verify-make: fail if a declared target has no recipe
verify-make:
	@for t in $$(grep '^.PHONY:' Makefile | cut -d: -f2-); do \
		if [ "$$t" != "help" ] && [ "$$t" != "verify-make" ] && \
		   ! grep -qE "^$$t:" Makefile; then \
			echo "FAIL: .PHONY declares '$$t' but no such target is defined"; \
			exit 1; \
		fi; \
	done
	@echo "ok: every declared target has a definition"
