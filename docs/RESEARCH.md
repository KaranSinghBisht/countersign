# Research — the landscape Pramaan is positioned against

Compiled Aug 2026. Everything here was verified against primary sources unless marked **UNVERIFIED**.

---

## 1. The buildathon itself

- Students only. Winners get an [AI Builder Internship](https://razorpay.com/ai-builders/): 6 or 12 months, in-person Bangalore, ₹75,000/month, starting September.
- Five tracks. **All five share one judging bar**, and it is written in the language of measurement, not features:
  > *"Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully."*
- Track 01 wording: grow merchant revenue via agents on Razorpay test-mode APIs, **or make a merchant transactable by an AI buyer end to end.**
- Submission: public repo + 5-min video + architecture writeup, via [forms.gle/d9r2gvxp8cmoZhon9](https://forms.gle/d9r2gvxp8cmoZhon9). **No deadline published on the page.**
- `razorpay.com/ai-builders` is a standing parallel funnel — submit a GitHub, call within 48 hours.

### What Razorpay's own engineering writing says they value

- **Bumblebee** ([dev.to/razorpaytech](https://dev.to/razorpaytech/meet-bumblebee-agentic-ai-flagging-risky-merchants-in-under-90-seconds-2nlf)): the Analyzer "runs deterministic rules first: hard thresholds, blacklist checks, compliance violations. These rules are fast, explainable, and don't require LLM inference." LLM only for interpretive work. Different temperatures per agent.
- **Agent Readiness scorecard** ([razorpay/blade wiki](https://github.com/razorpay/blade/wiki/agent-readiness-score)): three pillars — Context (AGENTS.md, navigability, doc freshness), Testing, CI/CD. Bands: <30 Not Ready, 30–54 Needs Work, 55–79 Assisted, 80+ Ready. **This is a published rubric. Build to it literally and say so.**
- A 2025 internal hackathon winner's entire pitch was *simulate the policy on historical data before deploying it.*

---

## 2. Razorpay test mode — what actually works

| Capability | Test mode status |
|---|---|
| Orders, Payments, Capture, Refunds, Customers | ✅ full |
| Payment Links | ✅ but **capped at 30 per business** |
| Invoices, Subscriptions, Smart Collect, Route | ✅ |
| **UPI Reserve Pay / SBMD mandates** | ❌ activation-gated, explicitly not testable in sandbox |
| Webhooks | ✅ — setup OTP `754081`; **ngrok and webhook.site are blacklisted**, use `zrok` |

Critical API facts:

- **`receipt` on Orders is a de-facto idempotency key** — a second create with the same value returns 400. There is **no** generic `Idempotency-Key` on Orders, Links, Invoices, or Capture.
- Real idempotency headers exist only on Refunds (`X-Refund-Idempotency`, min 10 chars), Route transfers (`X-Transfer-Idempotency`), and Payouts (`X-Payout-Idempotency`, **mandatory since 15 Mar 2025**).
- Webhooks are **at-least-once**, **unordered** (their docs explicitly warn `payment.captured` may precede `payment.authorized`), with a **5-second response budget** and auto-disable after 24h of failures. Dedupe on `x-razorpay-event-id`. Signature is HMAC-SHA256 over the **raw body** with the **webhook secret** — a different secret from the checkout signature, which is HMAC over `order_id|payment_id` with the API key secret.
- Rotating the webhook secret leaves older retries signed with the old one. Keep both valid during a rotation window.
- [MCP server](https://github.com/razorpay/razorpay-mcp-server): 35–40+ tools, hosted remote + self-hosted local, `READ_ONLY` flag. The remote merchant token is **`base64(key:secret)`** — reversible encoding of a full-privilege credential, not a scoped one.

---

## 3. Protocol landscape

| Protocol | Owner | Shape | India-relevant? |
|---|---|---|---|
| **ACP** | OpenAI + Stripe | 5-op checkout session, `/.well-known/acp.json`, **11 statuses**, normative MCP binding since 2026-04-17 | transport-neutral, yes |
| **UCP** | Google + Shopify | capability profile at `/.well-known/ucp`, transport-agnostic REST/MCP/A2A, conformance suite | yes |
| **AP2** | Google → **FIDO Alliance** (Apr 2026) | Checkout + Payment Mandates as SD-JWTs, open/closed variants, `cnf` key binding | the mandate model to copy |
| **MPP** | Stripe + Tempo (Mar 2026) | `Payment` HTTP auth scheme on `WWW-Authenticate`, sessions for streaming micropayments | **the shape to copy** |
| **x402 v2** | Coinbase → Linux Foundation | `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` headers, facilitator `/verify` `/settle` `/supported` | crypto rails only |
| **P3P** | **Pine Labs, June 2026** | MPP-shaped, on UPI ReservePay/OTM/Cards. Grantex = "OAuth for agents", scopes like `mpp:payment:max_txn_paise:50000` | **the precedent that this works domestically** |
| **NPCI UAP** | NPCI | reported, **no published spec** | watch, don't build on |

**The key finding:** P3P is structurally **MPP, not x402** — same `WWW-Authenticate: Payment` challenge, same `Payment-Receipt`, RFC 9457 problems, `mpp:` scopes. Their server SDK derives the challenge HMAC key from the PG client secret, which is MPP's stateless challenge binding. And their docs state the invariant we want: *"the P3P challenge and receipt format remains the same across all rails."*

x402 v2 explicitly blesses non-blockchain networks: *"Non-blockchain networks are encouraged to follow the CAIP-2 format (e.g. `ach:us`, `sepa:eu`)."* So `upi:in` is legitimate.

### Scheme mapping is unusually clean

- `exact` → one mandate, one debit for the exact amount
- `upto` → block ₹N, debit actual ≤ N. **This is literally Single Block Multi Debit.** Carry over `upto`'s four MUSTs — single-use, time bounds, recipient binding, settled ≤ authorized. Note SBMD supports *multi*-settlement which `upto` forbids, so repeated debits are closer to `session`. Say which you implement.
- `session` → block once, meter, batch-debit. Best fit for a metered digital product.

---

## 4. Competitors

### Prava Payments — the closest prior art

Two Bengaluru founders (Sushant Pandey, Shubham Kukreti), WTFund-backed (non-dilutive), Delaware entity, ~14 months to a live Visa Intelligent Commerce integration and PCI DSS Level 2. Genuinely impressive execution.

**But:** from the reference file their own agent reads to answer user questions —
> **Countries:** United States only at present. **India / UPI:** Not supported at this time.

- **"Multi-Protocol Support" names zero protocols.** Verified individually against their 297KB docs corpus: zero occurrences of x402, ACP, AP2, MPP, or Visa TAP. They support MCP (own server) and UCP (read-only client, Shopify discovery).
- Their skills explicitly exclude our domain: *"Not for: crypto/token transfers, **x402 API payments**, P2P payments."* Their security policy blocks crypto/wallet-funding/P2P merchant categories outright.
- **No merchant discovery layer.** The "Browser Harness" drives real Shopify checkout pages and self-heals when they change. Pitch to merchants is "zero changes on your end" — which is also why merchants are invisible to the network.
- No cryptographic mandates or receipts. Verifiability story is "you saw Visa's domain during approval" plus an order ID.
- No webhooks (poll only), no refund endpoints, JS/TS SDKs only, no CLI sandbox (agent-path testing uses real cards), Visa-only with Chase/Ramp/business/prepaid excluded.
- Traction thin: 7 stars on the top repo, 12 org followers, ~800 npm downloads/month, no named customer.

**Worth stealing from them** — all four are cheap:
1. The **in-conversation hard stop** before minting a credential. Their reasoning is the best UX insight in their stack: the biometric prompt is a second check, not a substitute, because users approve browser prompts on autopilot.
2. The **credential firewall** — over MCP the payment token never reaches the agent; the gateway executes server-side and returns only status.
3. **Adversarial skill evals** — 17+ labelled routing cases including negative and decoy fixtures (a fake competing skill, to test mis-routing).
4. **Honest enforcement labelling** — their guardrails table says exactly which constraints Visa enforces at the network level vs. which are just Prava's application code.

### Dodo Payments

Best AI-agent developer stack in payments right now: MCP with **Code Mode** (two tools — docs-search + sandboxed TS execution — instead of hundreds, ~1,000 tokens of context), 8 agent skills, Sentra billing agent, SDKs in 8 languages, full Merchant-of-Record. Stablecoin checkout globally, **excluding India**, via a Delaware entity.

But Dodo is **billing infrastructure for AI products**. Agent-as-*operator*, not agent-as-*buyer*. Barely intersects.

### Stripe / Bridge / Tempo

MPP + ACP + x402 support + MCP + Agentic Commerce Suite. Sessions as a first-class primitive for high-frequency micropayments. This is the total surface that makes Prava's "multi-protocol" tile look like what it is.

---

## 5. Regulatory reality (India)

- **RBI on stablecoins:** containment leaning toward prohibition for domestic retail payments; hostile to INR-pegged stablecoins. Told a parliamentary committee in July 2026 it favours containment.
- **June 2026:** ED raided five Bengaluru firms over ~₹2,500cr in USDT cross-border flow.
- **Pine Labs' CEO said publicly** they launch stablecoins in nine countries **and explicitly not India.**
- **Compliant precedent exists:** Xflow accepts stablecoins for Indian exporters by converting offshore to fiat before it lands. Razorpay holds a PA-CB licence.

**Conclusion:** UPI is the primary rail. A stablecoin adapter can exist, scoped to export corridors, stubbed, and labelled as future scope — the same line Pine Labs drew.

- **DPDP Act 2023 + Rules 2025:** notified 13 Nov 2025. Consent Manager framework live 13 Nov 2026; substantive obligations **13 May 2027**. Board members not yet appointed — nothing enforceable today.
- **RBI data localization** (6 Apr 2018 circular + 2019 FAQs): payment system data stored only in India; processing abroad permitted but must be deleted abroad and repatriated within 24 hours. **An LLM API call is processing.**
- **PCI DSS:** hosted Checkout keeps you in SAQ A. An embedded iframe pulls the merchant page into scope for the script-safety criterion (PCI SSC FAQ #1588).

---

## 6. Reference material by area

**Payments correctness** — [Brandur on idempotency keys in Postgres](https://brandur.org/idempotency-keys) · [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) · [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) · [TigerBeetle two-phase transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/) · [Modern Treasury: Accounting for Developers](https://www.moderntreasury.com/journal/accounting-for-developers-part-i) · [Uber: Zero-Sum by Design](https://www.uber.com/sv/en/blog/ubers-payments-platform/) · [Saga pattern](https://microservices.io/patterns/data/saga.html) · [AWS: Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) · [Fowler: allocate()](http://thierryroussel.free.fr/java/books/martinfowler/www.martinfowler.com/isa/money.html) · [Betterment: penny-precise allocation](https://www.betterment.com/engineering/penny-precise-allocation-functions)

**Protocols** — [ACP spec](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) · [UCP](https://ucp.dev) + [Shopify's UCP writeup](https://shopify.engineering/UCP) · [AP2](https://ap2-protocol.org/ap2/specification/) · [AP2 agent authorization](https://ap2-protocol.org/ap2/agent_authorization/) · [x402 v2](https://github.com/coinbase/x402) · [MPP / draft-ryan-httpauth-payment](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/) · [Pine Labs P3P](https://www.pinelabs.com/docs/online-payments/ai/p3p) · [MCP spec](https://modelcontextprotocol.io)

**Verifiability** — [RFC 6962 Certificate Transparency](https://datatracker.ietf.org/doc/rfc6962/) · [transparency-dev/tessera](https://github.com/transparency-dev/tessera) · [signed-note checkpoint format](https://github.com/transparency-dev/formats/blob/main/log/README.md) · [C2SP tlog-witness](https://github.com/C2SP/C2SP/blob/main/tlog-witness.md) · [Rekor CLI](https://docs.sigstore.dev/logging/cli/) · [Microsoft AGT ADR-0032 — the HMAC portability critique](https://microsoft.github.io/agent-governance-toolkit/adr/0032-agt-emits-trace-v01-trust-records/) · [ADR-0017 — what a hash chain does and doesn't prove](https://microsoft.github.io/agent-governance-toolkit/adr/0017-merkle-chain-for-audit-tamper-evidence/) · [RFC 8785 JCS](https://datatracker.ietf.org/doc/rfc8785/) · [aws-samples/sample-agentic-delegation](https://github.com/aws-samples/sample-agentic-delegation)

**Engineering craft** — [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457.html) · [Google AIP-158 pagination](https://google.aip.dev/158) · [Zalando API guidelines](http://opensource.zalando.com/restful-api-guidelines/) · [Nygard on ADRs](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions) · [Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/) · [Ubl on non-goals](https://medium.com/@cramforce/designing-even-larger-applications-460ee029012d) · [Google SRE Workbook: SLOs](https://sre.google/workbook/implementing-slos/) · [The RED method](https://grafana.com/blog/the-red-method-how-to-instrument-your-services/) · [Fowler: Contract Test](https://martinfowler.com/bliki/ContractTest.html) · [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [agents.md](https://agents.md/)

---

## 7. Flagged unverified

1. **Doot "Agent Authorization Ticket (AAT)"** — the acronym, the field list, and the "Agent Governance Manager countersigning after citizen approval" do not appear in the [Doot whitepaper](https://digidoot.in/Doot_WhitePaper.pdf). The *concepts* are all there (§4.1 identity-bound delegation, §4.2 least privilege, §4.4 human-in-the-loop, §4.7 auditability). **Cite for principles only. Do not cite AAT by name.**
2. **Prava's ">90% checkout success rate"** — self-reported, no methodology, no third-party benchmark.
3. **Prava's "US & SEA" marketing claim** — contradicted by their own agent-facing reference file, which says United States only. Zero mentions of any SEA country in their docs.
4. **A reported ₹20 lakh WTFund grant to Prava** — appeared in a search synthesis with no primary source. Their own blog describes WTFund as non-dilutive without naming an amount.
5. **Razorpay's uncaptured-authorization auto-refund window** — their capture-settings page says 3 days, their payments FAQ says 5. Treat as configurable; verify against the actual account.
6. **RFC 6962 and RFC 9162 are Experimental**, not Standards Track. Worth knowing before calling CT "the standard" on a slide.
