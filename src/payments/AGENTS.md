# Payments

extracted_at: 2026-08-22

Code lives in `src/razorpay/` (adapter) and `src/spend/` (authorization). This file is the map.

## Order of writes

1. `attemptSpend` — lock mandate spend, insert replay guard, `decide()`, increment, post the hold, fire `onDecision` (the audit record). One transaction.
2. `intendPayment` — same transaction as the spend. Inserts `payments` + outbox `create_order`. If this can commit while the spend rolls back, we will charge a refusal.
3. Worker `drainOne` — the only place that talks to Razorpay.
4. Webhook `ingest` — raw body, HMAC, `INSERT` on `x-razorpay-event-id`, monotonic state.
5. `reconcile` — classify; `adoptRemoteState` only for `STATE_MISMATCH`.

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
