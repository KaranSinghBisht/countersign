# Architecture

Countersign is a merchant-side agentic commerce server. An AI buyer proposes a purchase; a deterministic gate decides; a Razorpay order is the rail; a Merkle-chained audit log is the evidence. A third party verifies the evidence offline, with our process switched off, against public keys they already have.

```
agent proposal
      │
      ▼
  src/gate/accept.ts     schema + cart binding; message is hashed, never parsed
      │
      ▼
  src/mandate/verify.ts  open ← pinned issuer; closed ← open.cnf.jwk; narrows()
      │
      ▼
  src/policy/engine.ts   decide() — pure; same module the verifier imports
      │
      ▼
  src/payments/purchase.ts ONE txn: nonce burn, spend, audit record,
      │                    mandate artifacts, payment intent, idempotency
      ▼
  src/spend/accounting.ts  lock, replay guard, increment, onDecision
      │
      ▼
  src/razorpay/settle.ts   intend + outbox; timeout → in_doubt, never failed
      │
      ▼
  src/audit/log.ts         hash chain + RFC 6962 tree + Ed25519 checkpoint
      │                    (worker publishes a checkpoint when the log grows)
      ▼
  src/audit/export-live.ts the sealed prefix as a bundle (`make export`)
      │
      ▼
  src/verify/              30 checks, --trust pinned, USB-stick CLI
```

The LLM is not a principal. It cannot reach `decide()`. A prompt injection that reads "apply 90% off" fails at `accept()` because a discount is not a field and the amount is the cart we quoted.

## Why these shapes

**Mandates are compact JWS, AP2-shaped, two-link.** SD-JWT is where the standard is going and buys nothing while we are the only verifier. Open mandate is human-signed (today: a key we generated — see limitations). Closed mandate is agent-signed, ~120s, bound to a checkout hash we recompute. `narrows()` is fail-closed: a child that omits a parent cap is a deny, not unbounded.

**Policy is a pure function.** `now` and spend state are arguments. The verifier replays `decide()` against the exported bundle and must reach the same verdict. No `Date.now()`, no I/O, no map-iteration-order dependence.

**Money is `bigint` paise.** No floats. `format()` is the only function that knows a decimal point exists.

**The audit log is a hash chain plus an RFC 6962 Merkle tree plus a signed checkpoint.** An HMAC chain is tamper-evident inside a deployment and useless to a third party — verifying it needs the shared secret. The tree uses the domain-separation prefixes (`0x00` leaf, `0x01` node). `merkletreejs` omits them by default; we wrote sixty lines and tested them against the published RFC vectors. Every record carries `spent_before` / `amount` / `spent_after`, which is what turns omission from undetectable into a discontinuity at an exact `seq`.

**Razorpay `receipt` is derived, not generated.** `"pr" + base32(SHA256(closed_jti ‖ request_hash))`. A retry of the same purchase produces the same receipt. Razorpay rejects a second create with that value. A timeout is `in_doubt`; recovery is "ask Razorpay about *our* receipt", never a fresh one.

**Outbound calls go through a transactional outbox.** Write-then-call is a dual-write bug. Streams are serialized so a capture cannot overtake its create.

**Webhooks see the raw body.** A global JSON parser is the usual cause of signature failures. Dedupe is an `INSERT` keyed on the SHA-256 of the signed bytes — the `x-razorpay-event-id` header rides outside the signature, so a captured body replayed under fresh ids is still one event. State is monotonic; deliveries are unordered. The staleness window is 26 hours, because Razorpay retries for 24.

## What is not in the box

Discovery (ACP / UCP / `/agents.md`), a catalog, an MCP tool surface, and a 402 challenge route are designed and not shipped. HTTP today is `/healthz`, `POST /nonce`, `POST /purchase`, `POST /webhooks/razorpay`, and `GET /audit/*`. The live demo is `make demo` and the verifier, not Claude walking a checkout.

That is the weakest part of the submission. See below.

## Defense notes

A reviewer will ask these. The answers, unprompted.

### What is the weakest part?

The human root of trust is simulated, **and** an AI buyer cannot discover us.

The first is a cryptography honesty problem: `make keys` mints the issuer, so a verified chain proves our consent surface signed the open mandate, not that a person did. The second is a product honesty problem: Track 01 asked for a merchant an AI buyer can find and buy from end to end. We built the gate, the rail, and the proof. We did not build `/.well-known/acp.json`. A judge who opens the README, follows the quickstart, and expects Claude to complete a purchase will bounce.

We would rather be scored on the half nobody else built — bounded and provable — than ship a thin ACP wrapper over an unsigned log. That is a bet, not a disguise.

### Which decision would you reverse?

Hand-rolling the Merkle tree was correct (the prefixes). Hand-rolling a compact-JWS mandate instead of SD-JWT was correct for a two-week clock.

What we would reverse: **spending Day 10 on the Razorpay adapter before a single discovery document existed.** The adapter is the part we are proudest of (`in_doubt`, derived receipts, outbox, recon). It is also the reason there was no day left for `/agents.md`. A merchant that cannot be found and a merchant that can prove a purchase are different products; we picked the second and ran out of calendar on the first.

### What do two more weeks buy?

In order, and none of it is a dashboard:

1. `/.well-known/acp.json`, `/agents.md`, `/llms.txt`, and one ACP checkout session over the gate that already exists.
2. WebAuthn on the consent step, so the issuer key lives on a device.
3. POST each checkpoint to an endpoint we do not control. Completeness stays unprovable; equivocation becomes detectable.
4. An authenticated approval surface for the escalation resume path — a signed approval token bound to the closed mandate's `jti` — so `unresolved_constraint` stops being terminal over HTTP.
5. Wire `src/prompt/projection.ts` to an actual model call and keep `test/no-pii-in-prompt.test.ts` as the lock.

(An earlier version of this list included "an export of the audit bundle from real purchases." That shipped: `make export` and `test/integration/export.test.ts`.)

### Walk through a Razorpay 500

`POST /orders` returns 500, or times out, or we never see the response.

1. `intendPayment` has already committed, in the caller's transaction, a `payments` row and an outbox `create_order` whose payload carries **our** derived receipt. There is no second receipt to mint.
2. The worker calls Razorpay. A 5xx or a network error is retried, with the attempt counter, up to `MAX_ATTEMPTS`. A 4xx is failed — retrying a 400 forever is how a bad amount becomes a retry storm.
3. A **timeout** is not a 5xx. The create may have landed. The outbox row and the payment go to `in_doubt`. We do not mark the payment `failed`. We do not enqueue another `create_order`.
4. Recovery is `resolve_in_doubt`: `findOrderByReceipt(our_receipt)`. If Razorpay has the order, we record its id and clear `in_doubt`. If a later create somehow races, Razorpay's own 400 (`RazorpayDuplicateReceipt`) is treated as success and looked up the same way.
5. If Razorpay has never seen the receipt, reconciliation reports `IN_DOUBT_UNRESOLVED` or `MISSING_AT_PSP`. It does not invent a local payment and it does not mint a new receipt. An operator decides; the program does not guess.

Marking the timed-out create failed and retrying with a new receipt is precisely how one purchase becomes two. That path is not in this codebase.
