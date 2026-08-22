# Countersign

> **countersign** *(n.)* — a second signature that validates the first; also, the word you must give at a checkpoint before you are let through.

**A merchant server that an AI buyer can discover and buy from — and that can prove, afterwards, that the agent was never allowed outside its budget.**

Built for the [Razorpay AI Buildathon](https://razorpay.com/buildathon/), Track 01 — AI Growth & Agentic Commerce.

Both senses of the name are load-bearing. A buying agent's authority arrives as a signature that only counts because a human's signature endorsed it, and no money moves until the agent produces the right token at a gate.

---

## The gap

Razorpay's MCP server lets an agent **operate a merchant's account**. Prava Payments lets a buyer's agent **pay**. Neither builds the part in between: a merchant an AI buyer has never met can't *find* it, can't *quote* against it, and can't *prove* what happened afterwards.

Prava's answer to discovery is browser automation against Shopify checkouts — which is what you build when the merchant side of your network is empty. Track 01 asks for a merchant made "transactable by an AI buyer end to end." That's the missing half.

## What this is

| Property | How |
|---|---|
| **Discoverable** | `/.well-known/acp.json`, `/.well-known/ucp`, `/agents.md`, `/llms.txt` — ChatGPT, a Shopify-style agent, Claude, or a curl loop all find it |
| **Transactable** | One service layer exposed as ACP REST *and* an MCP tool surface (spec `2026-07-28`), plus HTTP 402 on UPI rails |
| **Bounded** | Signed, attenuable spending mandates the agent cannot widen — enforced in deterministic code the LLM cannot reach |
| **Provable** | Merkle-chained, publicly-signed audit log, plus a standalone verifier a third party runs offline with our server switched off |

## The design decision that matters

**The LLM is not a principal. It is an untrusted input to a policy engine that is.**

The agent proposes. A deterministic gate decides — mandate chain verification, attenuation, request binding, replay guard, spend accounting, policy — before any money moves. An unknown constraint type is a *deny*, not a pass. A prompt injection saying "apply 90% off" fails at the API boundary, not in the prompt.

This mirrors the architecture Razorpay published for Bumblebee: deterministic rules first, because they are "fast, explainable, and don't require LLM inference."

## Status

Foundations built; the gate, ledger, audit log and verifier are next.

Done so far: integer-paise money with a property-tested conservation invariant, RFC 8785 canonicalization written in-house and differentially tested against the reference implementation, ES256/Ed25519 signing with committed golden vectors, allow-list log redaction that fails closed, and boot-time config validation that refuses to start with a live Razorpay key.

- **[`docs/PLAN.md`](docs/PLAN.md)** — the full build plan: locked decisions, architecture, schedule, mandate and audit schemas, limitations
- **[`docs/RESEARCH.md`](docs/RESEARCH.md)** — the landscape this is positioned against, with sources, including what could *not* be verified

## Quickstart

```bash
make setup   # install pinned deps, create .env, generate signing keys
make up      # postgres + jaeger, waits on real healthchecks
make check   # lint, types, tests, credential scan
```

Add your `rzp_test_` credentials to `.env`. The service refuses to boot with a live key, and CI fails the build if one reaches a tracked file or the git history.

## Protocol shape

MPP, not x402 — because the rail is a gateway, not a chain.

Pine Labs' P3P is India's only shipped agentic payment protocol, and it uses `WWW-Authenticate: Payment` + `Payment-Receipt` + RFC 9457, with scopes namespaced `mpp:`. Copy the one that already works on UPI.

The three substitutions a fiat rail forces, and none of them are cosmetic:

1. There is no client-side signature, so **HMAC challenge binding + a delegation JWT** reconstruct the authority a blockchain signature would have carried for free.
2. Settlement is not publicly verifiable — a `razorpay_payment_id` is only checkable by asking Razorpay — so receipts are **JWS-signed with a published verifying key**.
3. UPI debits are asynchronous, so `/settle` returns **202 plus a poll URL**, and a receipt is never issued for a pending debit.

## Limitations

Stated up front, in [`docs/PLAN.md` §7](docs/PLAN.md). The short version: a Merkle log proves everything in it is unchanged but cannot prove nothing is missing; the signing keys are on the box; the human root of trust is simulated rather than a passkey; and UPI Reserve Pay is modelled, not live, because SBMD mandates are activation-gated and explicitly not testable in sandbox.

Bounded, gated and logged is not the same as correct. Cryptography constrains authority. It does not confer judgment.
