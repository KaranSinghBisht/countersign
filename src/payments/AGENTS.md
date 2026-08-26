# Payments

extracted_at: 2026-08-26

Code lives in `src/razorpay/` (adapter) and `src/spend/` (authorization), composed by `src/payments/purchase.ts`. This file is the map.

## Order of writes

`purchase()` claims the idempotency key first (its own commit — the row must exist before any outbound call could ever happen), then runs ONE transaction:

1. `consume` — burn the server-issued nonce. A thrown error rolls this back too, so a transient failure does not brick the (nonce, closed mandate) pair; a deliberate refusal commits the burn.
2. `mandate_artifacts` insert — the raw JWSes + checkout the exported bundle will need. Evidence commits with the decision it substantiates.
3. `attemptSpend` — lock mandate spend, insert replay guard, `decide()`, increment, post the hold, fire `onDecision`. Runs as a savepoint inside the outer transaction.
4. Inside `onDecision`: `append` (the audit record — ALLOW, DENY and ESCALATE alike), then `intendPayment` on permit only. Inserts `payments` + outbox `create_order`. If this can commit while the spend rolls back, we will charge a refusal.
5. `complete` — the idempotency response, stored in the SAME transaction, so a replayed answer can never disagree with what committed.

Then, outside the request:

6. Worker `drainOne` — started from `src/http/server.ts` (`startWorkers`). The only place that talks to Razorpay. The worker also publishes checkpoints when the log grows and reaps expired nonces/leases.
7. Webhook `ingest` — raw body, HMAC, `INSERT` deduped on the signed body's SHA-256 (the event-id header rides outside the signature), monotonic state.
8. `reconcile` — classify; `adoptRemoteState` only for `STATE_MISMATCH`.
9. `exportLiveBundle` (`src/audit/export-live.ts`, `make export`) — the sealed prefix of the log, with mandates/checkouts/receipts, as a bundle the offline CLI verifies.

## Receipts

`deriveReceipt(closed_jti, request_hash)` → `pr` + 38 Crockford chars. Inputs are length-prefixed. A timeout that landed is recovered by this value. A second create with this value is Razorpay's 400, and we treat that as success and look the order up.

## Outcomes that are easy to get wrong

| Symptom | What we do | What not to do |
|---|---|---|
| Timeout on `orders.create` | `in_doubt` + `resolve_in_doubt` | mark failed, mint a new receipt |
| 5xx | retry the same outbox row | enqueue a second create |
| 4xx | `failed` | retry forever |
| Duplicate receipt | look up, complete | treat as a new purchase |
| Dropped webhook | recon `STATE_MISMATCH` → new capture post | `UPDATE` the hold |
| Amount disagrees | `AMOUNT_MISMATCH`, stays on the list | "fix" the local row |
| PSP has an order we do not | `MISSING_LOCALLY`, stays on the list | insert a payment we never intended |

Webhook staleness is **26 hours**, not five minutes. Razorpay retries for 24h; copying Stripe's window rejects legitimate deliveries.

Deliveries are unordered. `payment.captured` may precede `payment.authorized`. Rank is monotonic; a captured payment does not walk back.

`src/demo/rehearse.ts` → `droppedWebhook()` and `duplicateReceipt()` are the live checks.
