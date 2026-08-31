/**
 * Discovery documents for machine readers.
 *
 * /agents.md is the contract a buyer agent reads before it spends: endpoints,
 * mandate claims, constraint semantics, error shapes. /llms.txt is the
 * one-screen pointer for crawlers that expect that convention.
 *
 * These are honesty-bound the same way the README is: every endpoint and
 * field listed here must exist on the running server, and what is NOT built
 * (catalog, ACP session, MCP tools) is said outright rather than implied.
 */

export const agentsMd = `# Countersign — for buyer agents

A merchant-side spend gate on Razorpay (test mode). You cannot talk this
server into anything: purchases are decided by deterministic code over a
signed mandate chain, and every decision — ALLOW, DENY or ESCALATE — lands in
a Merkle-logged audit trail your principal can verify offline.

Base URL: the origin serving this document. All bodies are JSON. Unknown or
extra fields are rejected, not ignored.

## The flow

1. \`POST /nonce\` with \`{"issued_to": "<your agent id>"}\` →
   \`{"nonce": "...", "expires_at": "..."}\`. Nonces are single-use and expire
   in ~300 seconds. Your closed mandate must commit to this exact value.
2. Construct the cart you were quoted:
   \`{"total_paise": <int>, "currency": "INR" | "USD" | "JPY", "payee": {"id": "..."}, "rail": "razorpay_order", "category"?: "..."}\`.
   Money is integer minor units everywhere. There is no catalog or quoting
   endpoint yet — carts are agreed out of band today (limitation, stated).
3. Sign a **closed mandate** (compact JWS, ES256) with the key your human's
   **open mandate** endorsed in \`cnf.jwk\`. Claims:
   - \`vct\`, \`iss\`, \`jti\` (ULID), \`iat\`, \`exp\` (~120 s lifetime)
   - \`aud\` — this deployment's base URL
   - \`parent_hash\` — SHA-256 of the open mandate's JWS bytes
   - \`request_hash\` — SHA-256 of the RFC 8785 (JCS) canonicalization of the
     checkout object the server recomputes from your cart
   - \`nonce\` — from step 1
   - \`amount\` (integer paise), \`payee\` — must equal the cart
   - \`agent\` — \`{id, version, model, runtime_sha256}\` (self-asserted, logged)
   A closed mandate cannot widen its parent: a cap the open mandate set and
   the closed one omits is a refusal, not freedom. An unknown constraint type
   is refused when the mandate is parsed (\`400 at: "mandate"\`).
4. \`POST /purchase\` with header \`Idempotency-Key: <unique per attempt>\` and
   body \`{"actor_id", "nonce", "open_jws", "closed_jws", "cart", "proposal"}\`
   where \`proposal\` is \`{"amount_paise", "currency", "payee", "rail", "message"?}\`.
   Your \`message\` is hashed and discarded — it is never parsed for a price,
   a discount, or an instruction.

## Wire details — what the verifier actually checks

- **JWS**: compact serialization, \`alg: ES256\`. The protected header MUST
  carry \`typ\` — \`application/countersign-open-mandate+jws\` for the open
  mandate, \`application/countersign-closed-mandate+jws\` for the closed one —
  and a \`kid\` that matches the verifying key's (the issuer's for open; your
  \`cnf.jwk.kid\` for closed). A wrong or missing \`typ\` is rejected before the
  signature is even checked.
- **\`vct\`** literals: open \`dev.countersign.mandate.spend.open.1\`, closed
  \`dev.countersign.mandate.spend.closed.1\`.
- **Digests** are SHA-256, **base64url without padding** (not hex).
  \`parent_hash\` = SHA-256 of the open mandate's compact JWS bytes.
  \`request_hash\` = SHA-256 of the RFC 8785 (JCS) canonicalization of the
  checkout object \`{"total_paise", "currency", "payee": {"id"}, "rail", "category"?}\`
  — key order does not matter, JCS decides it; \`category\` is omitted, not null.
- **Time**: all claims are Unix seconds. The server tolerates 30 s of clock
  skew on \`iat\`/\`nbf\`/\`exp\`; the offline verifier applies the same 30 s.
- **The open mandate** is issued by this deployment's operator (the human's
  consent surface is simulated today — there is no self-service endpoint).
  Ask the operator for one; in a local clone \`make keys\` mints the issuer key.
- **Reference client**: \`scripts/buy.ts\` (\`make buy\`) walks this whole flow
  against a running server and prints every step; read it before writing
  your own.

## Responses

- \`200 {"outcome": "permitted", "authorization_id", "closed_jti", "receipt", "audit": {"seq", "record_hash"}}\`
  — \`receipt\` is derived from your mandate, so a retry can never double-charge.
- \`400 {"outcome": "rejected", "at": "mandate" | "nonce" | "schema" | "cart_binding", "detail"}\`
  — \`schema\` covers a malformed body, an unknown field, a body that is not
  JSON, and a missing \`Idempotency-Key\` header. \`at: "mandate"\` also
  carries \`code\`: one of \`malformed\`, \`open_signature_invalid\`,
  \`closed_signature_invalid\`, \`parent_binding_invalid\`, \`claims_disagree\`
  (wrong audience, subject or nonce), \`not_attenuated\`,
  \`request_binding_invalid\`, \`expired\`, \`not_yet_valid\`.
- \`403 {"outcome": "denied", "reason", "decided_by", "audit"}\` — a named rule
  (e.g. \`R-BUD-INR\`) refused. Logged with counterfactual accounting.
- \`403 {"outcome": "escalate", "reason", "decided_by", "audit"}\` — above the
  human's escalation threshold. There is deliberately no approval flag you can
  send: the threshold is a signed constraint, and resume requires an
  authenticated approval surface that does not exist yet.
- \`409 {"outcome": "in_flight", "retry_after_seconds"}\` — your own earlier
  attempt is still running; honor \`Retry-After\`.
  \`409 {"outcome": "already_in_flight", "open_jti", "retry_after_seconds"}\`
  — AP2's one-in-flight rule: this open mandate has an authorization
  outstanding; nothing was spent, the nonce survives, honor \`Retry-After\`
  and resend. The slot frees when the payment settles — or when Razorpay
  refuses the order, so a refused order cannot wedge a mandate.
  \`409 {"outcome": "replayed", "closed_jti"}\` — that closed mandate was
  already used; sign a new one. In practice you will see \`at: "nonce"\` with
  \`code: "already_used"\` first, because the nonce is single-use and is
  checked before the closed-mandate replay guard: resubmitting the same
  \`(nonce, closed_jws)\` is refused at the nonce. The replay guard is the
  backstop for a mandate re-presented under a fresh nonce. No audit record is
  written for any 409: no decision was made.
- \`422 {"outcome": "mismatch", "detail"}\` — Idempotency-Key reused with a
  different body.
- \`429 {"outcome": "rate_limited", "detail"}\` with \`Retry-After\` — 120
  requests/min/IP on /nonce and /purchase; /audit/* shares one 60/min/IP
  bucket across all of its routes.
- Under one open mandate only one purchase may be in flight at a time
  (AP2), independent of budget headroom: concurrent buys under the same
  mandate answer \`already_in_flight\` until the first settles, even when the
  budget would admit more. Parallelism is across DISTINCT open mandates.
- \`500 {"outcome": "error", "detail": "internal"}\` — ours; nothing else is
  ever in that body. Retry with the same key.

Retry a timeout with the SAME Idempotency-Key: you will receive the stored
answer — a refusal included — never a second charge (the replay is
byte-equivalent JSON; key order may differ). Keys are scoped by the
\`actor_id\` you send: the same key under two actor ids is two attempts.
\`issued_to\` on a nonce is a label for your own bookkeeping — \`/nonce\` is
unauthenticated, so it is not bound to the mandate's \`sub\`; freshness and
single use are what the nonce enforces.

## Constraints your mandate may carry

\`spend.amount_range\`, \`spend.budget\`, \`spend.velocity\`,
\`spend.max_actions\`, \`spend.allowed_payees\`, \`spend.allowed_categories\`,
\`spend.escalation_threshold\`, \`spend.rail\` — all in integer minor units.
Deny outranks escalate. A currency no \`amount_range\` governs is denied.

## Audit

- \`GET /audit/checkpoint\` — latest Ed25519-signed checkpoint note, verbatim
- \`GET /audit/proof?seq=N\` — RFC 6962 inclusion proof against the latest
  SIGNED root, with the note; a record is sealed by the worker's next tick
  (~2 s), and asks before that answer 404 "not yet sealed"
- \`GET /audit/consistency?from=N\` — proof that the log only grew between a
  sealed size N and the latest checkpoint
- \`GET /audit/orders/:id\` — every record behind a Razorpay order, resolved
  through the payment the worker attached it to, so it answers once the
  order exists

Your principal verifies exported bundles offline with the \`countersign\` CLI
against keys obtained out of band. A \`trust.json\` inside a bundle is ignored.

## Not built, said plainly

No catalog, no quoting endpoint, no ACP/UCP session, no MCP tool surface, no
agent-driven checkout. A permitted purchase leaves a Razorpay order that a
HUMAN pays at \`/pay/<order_id>\` (Razorpay Checkout, test mode); an agent
does not drive that page. Open mandates are issued by this deployment's
operator (consent is simulated in the demo — see docs/LIMITATIONS.md in the
repository).
`;

export const llmsTxt = `# Countersign
> Merchant-side spend gate for AI buyers on Razorpay (test mode): signed
> mandate chain, deterministic policy, Merkle-logged audit trail, offline
> third-party verifier.

## Docs
- /agents.md: the contract a buyer agent follows to transact
- https://github.com/KaranSinghBisht/countersign: source, architecture, limitations

## API
- POST /nonce, POST /purchase (Idempotency-Key required)
- GET /audit/checkpoint, /audit/proof?seq=N, /audit/orders/:id
`;
