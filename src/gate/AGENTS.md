# Gate

extracted_at: 2026-08-22

`accept(cart, raw, constraints, state, now)` is the API boundary in front of `decide()`.

An agent can send a message. It can send one that reads like an instruction. The text is hashed (`prompt_sha256`) and discarded. It is never parsed for a price.

The amount that gets decided is the **cart we quoted**, not the amount the agent proposed. A proposal that disagrees with the cart is `cart_binding` and `decide()` does not run. A field the schema does not name (`discount_percent`, `coupon`, …) is `schema` and `decide()` does not run.

## Do not

- Add a pricing field to `AgentProposalSchema` to "support discounts." A discount is a new cart.
- Read `proposal.amount_paise` after the binding check. Read `cart.total_paise`.
- Inspect `message` for numbers, SKUs, or instructions. Hash it. Stop.
- Call `decide()` on a rejected proposal to "see what would have happened" and then honour that. Counterfactuals belong in the audit record, not in the return path.

`src/demo/rehearse.ts` → `promptInjection()` is the live check.
