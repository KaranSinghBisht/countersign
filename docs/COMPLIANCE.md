# Compliance posture

None of this is a live legal requirement today. The Data Protection Board's members are not yet appointed, and DPDP's substantive obligations commence 13 May 2027. These are the choices we would want already in place by then.

---

## DPDP Act 2023 + Rules 2025

Notified 13 November 2025, phased. Consent Manager framework 13 November 2026; notice, consent, rights, breach notification and cross-border rules **13 May 2027**.

What we did with that calendar:

- Prompts are not retained. The audit record stores `prompt_sha256` and `prompt_bytes`, not the text. The integrity-evidence clock and the personal-data clock can run independently.
- A hash proves nothing about content unless someone kept the content. That cost is deliberate and stated in `docs/LIMITATIONS.md`.
- Free-text an agent sends (`message`) is hashed at the gate and discarded. It is never an input to `decide()`.

## RBI data localization

Circular dated 6 April 2018, June 2019 FAQs. Payment system data is stored only in India. Processing abroad is permitted if the data is deleted abroad and repatriated within 24 hours.

**An LLM API call is processing.** If a prompt contains a payment identifier, a name, a VPA or a PAN, we have sent payment system data to a foreign inference endpoint.

Our answer is an allow-list, not a promise:

- `src/prompt/projection.ts` is the only view of an order an LLM is allowed to see: internal order id, SKUs, integer paise, coarse status.
- No PAN, name, email, phone, address, VPA, or Razorpay `payment_id`.
- `test/no-pii-in-prompt.test.ts` renders that projection against a dirty fixture and asserts none of those patterns survive.
- Logs are the same rule inverted: `src/telemetry/redact.ts` is an allow-list that fails closed. A field is emitted only if its key is known to be safe; unrecognized keys become `[redacted]`. A deny-list that forgot `customerVpa` would have shipped it.

We do not call an LLM in this repository. The projection exists so the first call cannot invent a wider view.

## PCI DSS

Card data never enters the system. Hosted Razorpay Checkout only. That is an **SAQ A posture**, not a compliance claim.

An embedded iframe would pull the merchant page into scope for the script-safety criterion (PCI SSC FAQ #1588). We do not embed.

## Razorpay credentials

- Test-mode keys only. `src/config.ts` refuses to boot on `rzp_live_`.
- CI greps the tree and the full git history (`scripts/scan-secrets.sh --all`).
- Secrets come from the environment, never from CLI flags — argv is visible in `ps`.
- The remote Razorpay MCP merchant token is `base64(key:secret)`: reversible encoding of a full-privilege credential, not a scoped one. We do not use that token. Noted so nobody copies it in later.

Webhook setup in test mode uses OTP `754081`. Razorpay blacklists ngrok and webhook.site; local delivery is `zrok`.
