# Submission crib sheet

Everything the form asks for, in one place. Fill the video URL after recording.

- **Project**: Countersign
- **One-liner**: A merchant server an AI buyer can buy from — and that can prove afterwards the agent was never allowed outside its budget.
- **Track**: 01 — AI Growth & Agentic Commerce. Judging bar, verbatim: *"Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully."*
- **Repo**: https://github.com/KaranSinghBisht/countersign — must be public before submitting; the live site's footer and `/llms.txt` already link to it
- **Live**: https://65-2-105-145.sslip.io (`/`, `/agents.md`, `/llms.txt`, `/healthz`, `/audit/*`) — Razorpay test mode
- **Video**: _add after recording — the script is [`DEMO.md`](DEMO.md)_

## What we built

A merchant-side spend gate for AI buyers on Razorpay test mode. A human-signed **open mandate** bounds an agent-signed **closed mandate** (~120 s to live, bound to a server nonce and the cart's hash); a pure `decide()` the LLM cannot reach evaluates every rule; the purchase, spend lock, audit record and payment intent commit in **one Postgres transaction**; a transactional outbox talks to Razorpay Orders / Checkout / webhooks; every action — ALLOW, DENY and ESCALATE alike — lands in a hash-chained, RFC 6962 Merkle, Ed25519-checkpointed audit log; a single-file offline verifier re-runs 30 checks and replays `decide()` with the server switched off.

## How to verify, fastest first

1. Open https://65-2-105-145.sslip.io — the scorecard maps the judging bar to runnable commands; `/agents.md` is the contract a buyer agent reads.
2. `make setup && make up && make check` — 401 unit tests, lint, types, secret scan, quoted counts.
3. `make demo` — eight rehearsed failures (prompt injection, budget deny, escalation, two tamperings, an omission, a dropped webhook, a duplicate receipt) and a bundle in `.countersign/export`.
4. `make cli && ./dist/countersign.mjs verify --bundle .countersign/export --trust .countersign/trust.demo.json` — 30 checks, exit 0, server off.
5. With `rzp_test_` credentials in `.env`: `make dev`, then `make buy`, then open the printed `/pay/order_…` link and pay with the test rails — the order and the captured payment appear on the Razorpay test dashboard. `make export` then verifies the **live** log the same way.

## Honest metrics

- 401 unit + 144 integration tests; the counts are pinned in CI (`scripts/check-counts.ts` fails `make check` if the copy drifts).
- 30 offline verifier checks across seven groups.
- 8 rehearsed failures, run live by `make demo`.
- 15 written limitations, each with a named remedy ([`LIMITATIONS.md`](LIMITATIONS.md)).
- Agent Readiness self-score 67% — below "Ready", published including the miss ([`../AGENTS.md`](../AGENTS.md)).
