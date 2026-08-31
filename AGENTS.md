# Countersign — agent guide

extracted_at: 2026-08-22

A merchant-side agentic commerce server. An AI buyer proposes; deterministic code decides; Razorpay is the rail; a Merkle log is the evidence. A third party verifies the evidence offline against pinned keys.

The LLM is not a principal. It cannot reach `decide()`.

## Commands

```
make setup              # deps, .env, signing keys
make up                 # postgres + jaeger
make check              # lint, types, unit tests, secret scan, quoted counts — not integration
make test-integration   # needs make up; 20-vs-3 and purchase→export→verify live here
make demo               # eight rehearsed failures; writes .countersign/export + trust.json
make export             # the LIVE audit log as a verifiable bundle (needs a checkpoint)
make cli                # dist/countersign.mjs — USB-stick verifier
```

`pnpm exec tsx src/cli/index.ts verify --bundle <dir|tar.gz> --trust ./trust.json`

Exit codes: 0 verified, 1 check failed, 2 malformed bundle, 3 trust error.

## Invariants — do not break these

- Money is `bigint` paise. No `number`, no float, no decimal string in the money path.
- `decide()` is pure. No clock, no I/O, no RNG. The verifier imports this module.
- The verifier never learns a key from the bundle. `--trust` is out of band. A `trust.json` sitting inside the export is ignored.
- Checkpoint verify takes the **caller's** key, never a key named by the note.
- A timeout talking to Razorpay is `in_doubt`, never `failed`. Recovery looks up **our** derived receipt. Do not mint a new one.
- Ledger is append-only. Reconciliation posts new balanced transactions. It does not `UPDATE` entries.
- Spend lock is `INSERT … ON CONFLICT DO UPDATE … RETURNING`. The two-step create-then-`FOR UPDATE` deadlocks.
- Idempotency key row commits **before** any outbound Razorpay call.
- A purchase is ONE transaction: nonce burn, spend lock, audit record, mandate artifacts, payment intent, idempotency completion. If any of those can commit while another rolls back, the evidence lies.
- Human approval never rides an unauthenticated request. `spend.escalation_threshold` is a SIGNED constraint; the HTTP body has no `human_approved` flag, and adding one is a bypass.
- Webhook dedupe keys on the SHA-256 of the signed raw body, not just the event-id header. The header is outside the signature.
- Unknown constraint type is a deny. A child that omits a parent cap is a deny.
- Webhook route sees the **raw body**. Do not put a global JSON parser above it.
- Logs are an allow-list (`src/telemetry/redact.ts`). Unrecognized keys are `[redacted]`.
- Prompts an LLM would see go through `src/prompt/projection.ts`. Do not add fields there to "help the model."
- Test-mode Razorpay keys only. `rzp_live_` refuses to boot and fails CI.

## Layout

| Path | What |
|---|---|
| `src/gate/` | API boundary. Schema + cart binding. [AGENTS.md](src/gate/AGENTS.md) |
| `src/mandate/` | Claim sets, `narrows()`, six-step chain verify |
| `src/policy/` | `decide()` |
| `src/spend/` | Accounting, nonce, one-in-flight |
| `src/ledger/` | Double-entry, holds as ordinary posts |
| `src/payments/` | Payment-domain map (razorpay + spend + settle). [AGENTS.md](src/payments/AGENTS.md) |
| `src/razorpay/` | Adapter, outbox, webhooks, recon |
| `src/audit/` | Hash chain, Merkle tree, checkpoints. [AGENTS.md](src/audit/AGENTS.md) |
| `src/verify/` | Thirty checks, CLI |
| `src/prompt/` | Allow-listed LLM projection |
| `src/demo/` | `make demo` |
| `docs/` | PLAN, RESEARCH, ARCHITECTURE, LIMITATIONS, COMPLIANCE |

## Agent Readiness self-score

Razorpay's published rubric ([blade wiki](https://github.com/razorpay/blade/wiki/agent-readiness-score), [engineering blog](https://razorpay.com/blog/razorpay-engineers-built-slash-slash-builds-the-rest/)): three pillars — Context, Testing, CI/CD. Bands: <30 Not Ready, 30–54 Needs Work, 55–79 Assisted, **80+ Ready**.

We score ourselves. The gaps stay in the table.

| Pillar | Score | /Max | % | Band | Notes |
|---|---:|---:|---:|---|---|
| Context | 10 | 14 | 71% | Assisted | Root + nested `AGENTS.md`. No `repo-skill` corpus, no Slash-extracted knowledge docs. |
| Testing | 22 | 30 | 73% | Assisted | 399 unit tests under `make check`; integration (webhook adversarial table, 20-vs-3 concurrency, recon, purchase→export→verify e2e) is a separate CI job. No browser E2E, no OpenAPI, no contract suite. |
| CI/CD | 7 | 14 | 50% | Needs Work | GitHub Actions: lint, types, unit, vector replay, secret scan on full history, integration against Postgres. No deploy, no agent-reviewer skill in CI. |
| **Aggregate** | **39** | **58** | **67%** | **Assisted** | Below Ready. Published including the miss. |

What would move this to 80: ACP/OpenAPI so an agent can exercise the HTTP surface; one deploy pipeline; a `repo-skill` with `extracted_at` on the domain notes. We did not spend the last day on those.

## Do not

- Add a float to a money path "just this once."
- Learn a verifying key from a bundle, a checkpoint note, or a JWS header `jwk`.
- Treat a Razorpay timeout as failure and retry with a new receipt.
- Put `express.json()` / Fastify's JSON parser on the webhook route.
- Widen `SAFE_KEYS` or the prompt projection to make a demo prettier.
- Commit `.env`, `trust.json`, `keys/`, or anything matching `rzp_live_`.
