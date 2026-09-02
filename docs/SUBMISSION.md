# Submission crib sheet

The exact fields of the "Razorpay AI Builder Internship 2026" form, with paste-ready
answers. Their site says the last question is the one they read first, and the form
ends with a no-edits-after-submit confirmation — so run the checklist at the bottom
before pressing Submit.

## Selected Track

Track 1: AI Growth & Agentic Commerce

## Project Name / Title

Countersign — provable agent spending on Razorpay

## Project Objectives (what does it solve?)

An AI agent can already spend money; nobody can prove it was allowed to. Countersign is the merchant side of that problem: a server an AI buyer can purchase from, where every money action is explainable, bounded and gated — the track's bar, taken literally. It enables AI-buyer transactions a merchant can accept today and prove were authorized afterwards. A human signs an open mandate (per-transaction cap, aggregate budget, payees, escalation threshold); the agent signs a ~120-second closed mandate bound to a server-issued nonce and the exact cart; a pure decide() function the LLM cannot reach evaluates every rule; the purchase, spend lock, audit record and Razorpay payment intent commit in one Postgres transaction. Every decision — refusals included — lands in a hash-chained, RFC 6962 Merkle, Ed25519-checkpointed audit log that a single-file verifier re-checks offline (30 checks) with the server switched off. The rail is real Razorpay test mode: orders, Checkout, signed callbacks, webhooks, capture, reconciliation — live at https://65-2-105-145.sslip.io, with 401 unit + 145 integration tests and the quoted numbers pinned in CI.

## GitHub Repository URL

https://github.com/KaranSinghBisht/countersign

## 5-min Pitch Video Link

(unlisted is fine — paste after recording; the script is DEMO.md)

## Build Challenges & Technical Obstacles (read first — the real resume)

The best bug found us in production. During a live test-mode payment, the payer tab closed during Checkout's redirect, so the signed callback never arrived — and the webhook had been registered seconds after the payment, so it never fired either. The payment sat authorized at Razorpay and our ledger didn't know. We recovered it by API capture, then made the recovery systematic: a reconciliation sweep every ~10 minutes lists Razorpay's view, adopts any state we missed, and queues capture for stranded authorizations. The first sweep then crashed in production — the real API returns fee: null until a payment is captured, which the docs don't advertise. Schema fixed, regression test added (commit `8ce9540`).

Double charges were the failure we designed against hardest. A timeout on order-create is not a failure — the order may have landed — so we refuse to guess: the payment goes to an in_doubt state and recovery asks Razorpay about our receipt. The receipt is derived (SHA-256 of the closed mandate id + request hash), so any retry produces the same receipt, and Razorpay's own duplicate-receipt 400 becomes our recovery signal instead of a second order. One purchase cannot become two; the integration suite proves it (`test/integration/razorpay.test.ts`: "treats a timeout as in_doubt, never as failed", "recovers a duplicate receipt as success").

The demo destroyed its own evidence. Our rehearsal command truncated the same database the real purchases lived in — following our own demo script (buy → rehearse → export) wiped the audit log mid-take. We caught it by pointing an adversarial agent at the script to run every command verbatim; rehearsals now run in their own database, created on first use (commit `cdaf73b`).

Two smaller ones: merkletreejs omits RFC 6962's domain-separation prefixes by default (leaf/node confusion makes proofs forgeable), so we hand-rolled ~60 lines and tested them against the RFC's published vectors (`src/audit/merkle.test.ts`). And the campus network blocks outbound SSH entirely, so the EC2 deployment runs through an Instance Connect Endpoint tunnel.

The repo also ships fifteen written limitations, each with a named remedy — the honest list is part of the build.

## Operator checklist — before pressing Submit (the form forbids edits afterwards)

1. Repo flipped PUBLIC — open the URL in an incognito window and see code.
2. Video uploaded (unlisted ok) — open the link in incognito, it plays.
3. Video link pasted into README and this file.
4. Live instance healthy: https://65-2-105-145.sslip.io/healthz → {"ok":true}.
5. Only then tick "Final Submission Confirmation" and Submit.

## Honest metrics (for any free-text space)

- 401 unit + 145 integration tests; the counts are pinned in CI (`scripts/check-counts.ts` fails `make check` if the copy drifts).
- 30 offline verifier checks across seven groups.
- 8 rehearsed failures, run live by `make demo`.
- 15 written limitations, each with a named remedy ([`LIMITATIONS.md`](LIMITATIONS.md)).
- Agent Readiness self-score 67% — below "Ready", published including the miss ([`../AGENTS.md`](../AGENTS.md)).
