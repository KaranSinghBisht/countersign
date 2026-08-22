.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

## help: list available targets
help:
	@echo "Pramaan — make targets"
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
check: lint typecheck test scan-secrets

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
## scan-secrets: fail if a live Razorpay key appears in tracked files
scan-secrets:
	@matches=$$(git grep -nIE --cached -e 'rzp_live_[A-Za-z0-9]{10,}' -- . \
		| grep -v 'pragma: allow-live-key' || true); \
	if [ -n "$$matches" ]; then \
		echo "$$matches"; \
		echo "FAIL: a live Razorpay key is staged. This project is test-mode only."; \
		exit 1; \
	else \
		echo "ok: no live keys in tracked files"; \
	fi

## vectors: regenerate the cryptographic test vectors (wire-format change)
vectors:
	@pnpm exec tsx scripts/gen-vectors.ts

## keys: print freshly generated signing keys without touching .env
keys:
	@pnpm exec tsx scripts/gen-keys.ts

.PHONY: help setup up down clean dev test test-integration check lint fix typecheck scan-secrets vectors keys
