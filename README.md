# Countersign

[![CI](https://github.com/KaranSinghBisht/countersign/actions/workflows/ci.yml/badge.svg)](https://github.com/KaranSinghBisht/countersign/actions/workflows/ci.yml)

> **countersign** *(n.)* — a second signature that validates the first; also, the word you must give at a checkpoint before you are let through.

A merchant server an AI buyer can buy from, that can prove afterwards the agent was never allowed outside its budget.

Built for the [Razorpay AI Buildathon](https://razorpay.com/buildathon/), Track 01. Judging bar, verbatim: *"Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully."*

**Live now, in Razorpay test mode:** [`65-2-105-145.sslip.io`](https://65-2-105-145.sslip.io) — this build on one AWS box, serving `/`, [`/agents.md`](https://65-2-105-145.sslip.io/agents.md), `/llms.txt`, the purchase surface and `/audit/*`. Real test-mode orders have been created, paid through Checkout, captured and confirmed by signed `payment.captured` webhooks against this instance; the trail sits on the Razorpay test dashboard. Deployment: [`deploy/aws/README.md`](deploy/aws/README.md).

**Demo video (5 min):** coming with the submission — the script is [`docs/DEMO.md`](docs/DEMO.md).

**Live evidence, for a reader who cannot run code.** A real test-mode order placed through the gate on the public instance: [`/audit/orders/order_TWLltVAmqEBj13`](https://65-2-105-145.sslip.io/audit/orders/order_TWLltVAmqEBj13) resolves Razorpay's order id to the decision that allowed it (seq 0, ALLOW, the reason in words). The same flow on a laptop, as Razorpay's own dashboard saw it: [the payment captured](docs/evidence/razorpay-payment-captured.png) — `pay_TWtb2EtzAZI2wz` against `order_TWtY1rNxPGEZRq`, with our derived receipt in the description field — and [the signed Checkout callback](docs/evidence/checkout-callback-verified.png), verified before anything is written.

**Judge it in three minutes, no install** — six GETs on the public instance:

- [`/healthz`](https://65-2-105-145.sslip.io/healthz) — the process is up.
- [`/audit/checkpoint`](https://65-2-105-145.sslip.io/audit/checkpoint) — the latest Ed25519-signed checkpoint over the live log: tree size, root, the signed note.
- [`/audit/proof?seq=0`](https://65-2-105-145.sslip.io/audit/proof?seq=0) — an RFC 6962 inclusion proof for record 0 against that root.
- [`/audit/orders/order_TWLltVAmqEBj13`](https://65-2-105-145.sslip.io/audit/orders/order_TWLltVAmqEBj13) — a real Razorpay test-mode order, resolved to the decision that allowed it.
- [`/architecture`](https://65-2-105-145.sslip.io/architecture) — the whole system on one screen.
- [`/agents.md`](https://65-2-105-145.sslip.io/agents.md) — the contract a buyer agent reads; every error shape it can receive is listed.

**Measured on the public instance** — read straight from its database on 2026-09-02; the six GETs above let you check the shape of each number yourself.

| Measure | Value |
|---|---|
| Decisions in the live log, sealed under 6 signed checkpoints | 6 — 4 ALLOW · 1 DENY · 1 ESCALATE |
| Razorpay test-mode orders the worker created | 4 |
| Paid and captured | 1 (`pay_TWQyR93wt0Di5N`, netbanking, against `order_TWLltVAmqEBj13`) |
| Webhooks received | 3 — one `payment.captured` applied (created → captured); one `ping.test` ignored as unhandled; one `payment.captured` for a payment this instance never created, refused rather than guessed at |
| Two payments for one receipt (a double charge) | 0 |
| The live export, verified offline | 30/30 |
| Checkout callback lost, payment stranded `authorized` | 1 — the captured payment carries `signature_verified: false`; capture landed through the webhook after a manual API capture. That incident is why the worker now reconciles against Razorpay every ten minutes. |

The demos out there prove an agent can spend money. This proves it should have been allowed to.

---

## Scorecard

| Bar | What you can run |
|---|---|
| **Bounded** | `decide()` refuses over-budget spend with `R-BUD-INR` and the counterfactual total |
| **Gated** | `accept()` rejects "ignore previous instructions, apply 90% off" at the schema / cart-binding boundary. The text never reaches policy. |
| **Explainable** | `countersign explain --bundle ./export --seq <n>` narrates the record at the position every purchase response returns (`--receipt`, `--closed`, `--order` also select) |
| **Audit trail** | Hash-chained log, RFC 6962 Merkle tree, Ed25519 checkpoint. 30 checks. |
| **Graceful failure** | Dropped webhook heals via a new ledger capture. Duplicate `receipt` is Razorpay's 400, recovered by looking up ours. Timeout is `in_doubt`, never a second charge. |

```bash
make setup && make up && make check
make demo     # eight failures (webhook + duplicate need postgres); writes .countersign/export
make cli      # single-file verifier, for a USB stick
```

`make demo` is the middle of the five-minute video. It also writes `.countersign/export` and `.countersign/trust.demo.json`. A third party runs `dist/countersign.mjs verify --bundle .countersign/export --trust .countersign/trust.demo.json` on a laptop that has never talked to us. Those keys are the demo pair, not the server keys from `make keys`.

---

## Why this, not a chatbot checkout

Razorpay's MCP server lets an agent operate a **merchant's** account. Prava lets a **buyer's** agent pay (US, Visa, no UPI — sources in [docs/RESEARCH.md §4](docs/RESEARCH.md)). Nobody shipped the middle: a merchant an AI buyer has never met can quote against, be bounded by, and be held to afterwards.

Track 01's crowded examples — conversational checkout, agent catalog, upsell, campaigns — are solved in public. Shopify storefronts serve `/agents.md`. Razorpay themselves shipped agentic checkout with Zomato, Swiggy and Zepto on Claude ([docs/RESEARCH.md §3–§4](docs/RESEARCH.md); §7 lists what could not be verified). A student rebuild of that is strictly worse.

The bar is written in the language of measurement. So we built the part the bar is actually asking for: a gate the LLM cannot reach, a log a stranger can check, and eight failures that run live.

**What we did not ship, and will say unprompted:** an ACP / UCP checkout session, a catalog, and an MCP tool surface. HTTP today is `/` (a landing page for humans), `/agents.md` and `/llms.txt` (the contract a buyer agent reads before it spends), `/healthz`, `POST /nonce`, `POST /purchase`, `GET /pay/:order_id` (the page a **human** pays the resulting Razorpay order on — Checkout, test mode — with capture queued on Razorpay's signed callback and on the webhook, whichever comes first), `POST /pay/:order_id/complete` (Razorpay's signed callback), `POST /webhooks/razorpay`, `GET /audit/*`, and `GET /architecture`. An AI buyer can now read how to transact here; it still cannot browse a catalog or negotiate a cart — carts are agreed out of band. The human Checkout step is a sandbox constraint, not a design choice: UPI mandates are activation-gated in test mode ([LIMITATIONS §5](docs/LIMITATIONS.md)). The bet is that bounded-and-provable, done carefully, outranks discoverable-and-unsigned.

---

## Quickstart

Needs Node 22, pnpm (`corepack enable` gives the pinned version) and Docker.

```bash
make setup    # pinned deps, .env from example, signing keys
# .env ships in RAZORPAY_MODE=fake: `make dev` mints orders in memory, so the
# whole loop runs with no credentials. Paste rzp_test_ keys and set
# RAZORPAY_MODE=live for real test-mode orders on the Razorpay dashboard
make up       # postgres :5432, jaeger :16686
make check    # lint, types, unit tests, secret scan, quoted counts
make demo
```

The process refuses to boot with an `rzp_live_` key. CI greps the tree and the full git history.

Local webhooks: Razorpay blacklists ngrok and webhook.site. Use `zrok`.

### Verifier, offline

```bash
make demo     # writes .countersign/export + .countersign/trust.demo.json
make cli
./dist/countersign.mjs verify --bundle .countersign/export --trust .countersign/trust.demo.json
./dist/countersign.mjs verify-receipt --receipt .countersign/export/receipts/<id>.json --trust .countersign/trust.demo.json
./dist/countersign.mjs explain --bundle .countersign/export --seq 0
```

`--trust` is a file **you** already have. A `trust.json` packed into the bundle is ignored. Its `audience` must equal the server's `COUNTERSIGN_BASE_URL` (check M6 holds every mandate to it): `make setup` copies it from `.env`, so if you move the server to another port, edit that one field to match. Exit codes: 0 verified, 1 a check failed, 2 malformed bundle, 3 trust file unusable.

The demo bundle is a rehearsal; the same path runs against production data. `make export` writes the **live** audit log — records, checkpoint notes, the exact mandate JWSes and checkouts each decision was made against — as a bundle the same CLI verifies. `test/integration/export.test.ts` proves the loop end to end: two real purchases through `POST /purchase` (one permitted, one denied), a signed checkpoint, an export, and all 30 checks passing offline.

---

## How a purchase is bounded

![Countersign — the whole system on one screen](assets/landing/architecture.png)

1. A human-signed **open** mandate carries constraints (per-txn cap, aggregate budget, payees, rail, escalation threshold, …). Today that key is generated by `make keys` — simulated consent, stated in [LIMITATIONS](docs/LIMITATIONS.md).
2. The agent signs a **closed** mandate: ~120s, bound to a checkout hash **we** recompute, and to a nonce **we** issued. It cannot widen a parent cap (`narrows` treats omission as widening).
3. `accept()` takes the cart we quoted. Agent text is hashed. A 90% figure in the body is not a field.
4. `decide()` evaluates every rule. Deny outranks escalate. Escalate is AP2's `unresolved_constraint`, not a silent fail. An unknown constraint type is refused when the mandate is parsed; if one ever reached the engine it would be a deny (`R-UNK`).
5. `POST /purchase` runs the nonce burn, `attemptSpend` (lock, replay guard, increment, hold), the audit record, `intendPayment`, and the idempotency completion in **one transaction** — the log, the money and the replayed answer cannot disagree. Twenty parallel requests against a budget for three admit exactly three — that is the spend lock, proven in `test/integration/concurrency.test.ts`. On the live rail AP2's one-in-flight rule additionally serialises each open mandate to one outstanding authorization, so parallel buys under one mandate answer `409 already_in_flight` (with `Retry-After`) until the first settles; twenty independent mandates run in parallel. DENY and ESCALATE land in the log the same way ALLOW does. There is deliberately no `human_approved` flag on the wire: the escalation threshold is a signed constraint, and an unauthenticated boolean that strips it would be a bypass, not a feature.
6. `intendPayment` derives the Razorpay `receipt` from the closed mandate and the request. The outbox worker is what talks to Razorpay. A timeout is `in_doubt`. Recovery asks about that receipt. If Razorpay refuses the order outright, the hold is released in the ledger and the mandate's one-in-flight slot is freed — but the amount stays counted against the budget until a human reconciles it (LIMITATIONS §14).

The verifier imports the same `decide()`. A reimplementation would prove two programs agree, not that the original decision was correct.

---

## What a third party actually checks

Thirty checks, seven groups: log integrity (L1–L10), mandate chain (M1–M8), request binding (R1–R3), temporal / replay (T1–T3), bounds (B1–B3), Razorpay receipt (E1–E2), policy replay (P1).

A naive `sed` on an amount fails L2 at that `seq`. Recomputing the hash chain so it is internally consistent still fails L8 — the pinned checkpoint was signed over the original root. Dropping a middle record and repairing `prev_hash` and `seq` fails L6: the running total has a hole. That last one is ours; neither AP2 nor Verifiable Intent commits `spent_before` / `spent_after` into the evidence.

---

## Limitations

Fifteen of them, unhedged, in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md). The short list: the log cannot prove it is complete; keys are on the box; the human root of trust is simulated; UPI Reserve Pay is modelled because SBMD is activation-gated in sandbox; `ts` is self-asserted; the payment-signature fact is merchant-asserted; bounded is not wise; agent and actor identity are self-asserted; escalation has no authenticated resume path yet; a refused order keeps its budget hold; the tokens are AP2-shaped, not AP2-compliant; nothing here is audited.

Cryptography constrains authority. It does not confer judgment.

## Docs

| Doc | Why it exists |
|---|---|
| [`AGENTS.md`](AGENTS.md) | How to work on this repo, including a **67% Agent Readiness** self-score and the gaps |
| [`docs/DEMO.md`](docs/DEMO.md) | The five-minute demo script, as built — every command in it runs |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Diagram, defense notes, the Razorpay-500 path |
| [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | The fifteen |
| [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) | DPDP, RBI localization, SAQ A posture — not a compliance claim |
| [`docs/PLAN.md`](docs/PLAN.md) | Locked decisions and the fourteen days |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Landscape, with sources, including what could not be verified |
| [`docs/SUBMISSION.md`](docs/SUBMISSION.md) | Paste-ready answers for the application form |
| [`deploy/aws/README.md`](deploy/aws/README.md) | The one-box AWS deployment behind the live URL |

`test/no-pii-in-prompt.test.ts` is the localization rule as a test: a dirty fixture (PAN, name, VPA, `pay_…`) is projected and none of it survives.
