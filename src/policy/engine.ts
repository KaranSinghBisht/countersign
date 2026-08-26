/**
 * The policy engine.
 *
 * `decide()` is a pure function. No clock reads, no random values, no I/O, no
 * database, no network — `now` and the spend state are arguments. That is what
 * lets the standalone verifier import this module and reach the same verdict
 * from an exported audit bundle, with our server switched off. Same code, two
 * callers; a re-implementation would only prove that two programs agree, not
 * that the original decision was correct.
 *
 * The LLM is not a principal here. Everything in this file is deterministic
 * code operating on a verified mandate chain, and no text an agent produces
 * can reach it. A prompt injection reading "apply a 90% discount" fails at the
 * API boundary because the discount was never an input to this function.
 *
 * Unlike chain verification, evaluation does NOT abort on the first failure.
 * Every rule is evaluated so the audit record can show the complete picture,
 * and `first_deny` names the one that decided the outcome. A record showing
 * only "denied at rule 3" cannot answer whether rule 7 would also have
 * refused, which is exactly what someone reconstructing an incident needs.
 */

import type { Constraint } from "../mandate/constraints.js";
import { constraintKey } from "../mandate/constraints.js";
import {
  add,
  type CurrencyCode,
  format,
  greaterThan,
  type Money,
  money,
  zero,
} from "../money/money.js";

/**
 * Written into every audit record. The verifier replays `decide()` from this
 * same module, so the version travels with the evidence rather than being
 * asserted after the fact.
 */
export const ENGINE_VERSION = "0.3.1";

export type Effect = "permit" | "deny" | "escalate";

export interface RuleOutcome {
  /** Stable across runs and across constraint reordering. */
  readonly id: string;
  readonly constraint: Constraint["type"];
  readonly effect: Effect;
  readonly detail: string;
}

export interface Decision {
  readonly effect: Effect;
  readonly reason: string;
  readonly rules: readonly RuleOutcome[];
  /** The rule that produced the outcome, or null on a clean permit. */
  readonly decidedBy: string | null;
}

export interface PurchaseRequest {
  readonly amount: Money;
  readonly payee: { readonly id: string };
  readonly rail: string;
  readonly category?: string;
}

/**
 * What has already been spent under this mandate.
 *
 * Supplied by the caller from the ledger rather than read here, so the engine
 * stays pure and the verifier can replay a decision from the audit bundle.
 */
export interface SpendState {
  readonly spent: Money;
  readonly actions: number;
  /** Settled actions with timestamps, for the rolling velocity window. */
  readonly recent: readonly { readonly at: number; readonly amount: Money }[];
}

const RULE_PREFIX: Record<Constraint["type"], string> = {
  "spend.amount_range": "R-AMT",
  "spend.budget": "R-BUD",
  "spend.velocity": "R-VEL",
  "spend.max_actions": "R-ACT",
  "spend.allowed_payees": "R-PAY",
  "spend.allowed_categories": "R-CAT",
  "spend.escalation_threshold": "R-ESC",
  "spend.rail": "R-RAIL",
};

const ruleId = (c: Constraint): string =>
  "currency" in c ? `${RULE_PREFIX[c.type]}-${c.currency}` : RULE_PREFIX[c.type];

export function decide(
  constraints: readonly Constraint[],
  request: PurchaseRequest,
  state: SpendState,
  now: number,
): Decision {
  // Sorted, not map order. Two callers iterating a Map in insertion order
  // reach the same verdict only by accident, and the verifier receives
  // constraints from a JSON bundle whose ordering we do not control. Sorting
  // makes `rules` byte-identical on both sides.
  const ordered = [...constraints].sort((a, b) =>
    constraintKey(a) < constraintKey(b) ? -1 : constraintKey(a) > constraintKey(b) ? 1 : 0,
  );

  const rules = ordered.map((c) => evaluate(c, request, state, now));

  // A currency with no per-transaction range is a currency nobody bounded.
  // Fail closed rather than permitting an unconstrained spend in a currency
  // the human never considered.
  const governed = ordered.some(
    (c) => c.type === "spend.amount_range" && c.currency === request.amount.currency,
  );
  if (!governed) {
    const detail =
      `no spend.amount_range constraint governs ${request.amount.currency}, ` +
      `so this purchase is unbounded in that currency`;
    return {
      effect: "deny",
      reason: detail,
      rules: [...rules, { id: "R-CUR", constraint: "spend.amount_range", effect: "deny", detail }],
      decidedBy: "R-CUR",
    };
  }

  // Deny outranks escalate. Escalating something the mandate forbids would
  // ask a human to approve what they already declined to authorise, and the
  // approval UI is not a place to widen a mandate.
  const denied = rules.find((r) => r.effect === "deny");
  if (denied !== undefined) {
    return { effect: "deny", reason: denied.detail, rules, decidedBy: denied.id };
  }

  const escalated = rules.find((r) => r.effect === "escalate");
  if (escalated !== undefined) {
    return { effect: "escalate", reason: escalated.detail, rules, decidedBy: escalated.id };
  }

  return {
    effect: "permit",
    reason: describePermit(ordered, request, state),
    rules,
    decidedBy: null,
  };
}

function evaluate(
  c: Constraint,
  request: PurchaseRequest,
  state: SpendState,
  now: number,
): RuleOutcome {
  // Closed at the type level; this branch is for a forged runtime object
  // that skipped ConstraintSchema. Unknown types are a deny, never a skip.
  if (!Object.hasOwn(RULE_PREFIX, c.type)) {
    return {
      id: "R-UNK",
      constraint: c.type,
      effect: "deny",
      detail: `unknown constraint type ${String(c.type)}`,
    };
  }

  const id = ruleId(c);
  const permit = (detail: string): RuleOutcome => ({
    id,
    constraint: c.type,
    effect: "permit",
    detail,
  });
  const deny = (detail: string): RuleOutcome => ({
    id,
    constraint: c.type,
    effect: "deny",
    detail,
  });

  switch (c.type) {
    case "spend.amount_range": {
      if (c.currency !== request.amount.currency) return permit("does not apply: other currency");
      const amount = request.amount.amount;
      if (amount < c.min) {
        return deny(
          `below the permitted floor (${format(request.amount)} < ${fmt(c.min, c.currency)})`,
        );
      }
      if (amount > c.max) {
        return deny(
          `above the per-transaction cap (${format(request.amount)} > ${fmt(c.max, c.currency)})`,
        );
      }
      return permit(
        `within the per-transaction cap (${format(request.amount)} ≤ ${fmt(c.max, c.currency)})`,
      );
    }

    case "spend.budget": {
      if (c.currency !== request.amount.currency) return permit("does not apply: other currency");
      const after = add(state.spent, request.amount);
      if (after.amount > c.max) {
        return deny(
          `would exceed the aggregate budget (${format(after)} > ${fmt(c.max, c.currency)})`,
        );
      }
      return permit(`within the aggregate budget (${format(after)} ≤ ${fmt(c.max, c.currency)})`);
    }

    case "spend.velocity": {
      if (c.currency !== request.amount.currency) return permit("does not apply: other currency");

      // Half-open window: an action exactly window_seconds old has aged
      // out. Closed on both ends, an action could be counted twice at the
      // boundary depending on which side the comparison landed.
      const since = now - c.window_seconds;
      const inWindow = state.recent.filter(
        (a) => a.at > since && a.amount.currency === request.amount.currency,
      );

      const spentInWindow = inWindow.reduce(
        (acc, a) => add(acc, a.amount),
        zero(request.amount.currency),
      );
      const totalAfter = add(spentInWindow, request.amount);

      if (totalAfter.amount > c.max_amount) {
        return deny(
          `would exceed ${fmt(c.max_amount, c.currency)} in ${c.window_seconds}s ` +
            `(${format(totalAfter)})`,
        );
      }
      if (inWindow.length + 1 > c.max_count) {
        return deny(
          `would exceed ${c.max_count} transactions in ${c.window_seconds}s ` +
            `(this would be ${inWindow.length + 1})`,
        );
      }
      return permit(
        `within ${c.max_count} transactions and ${fmt(c.max_amount, c.currency)} ` +
          `per ${c.window_seconds}s`,
      );
    }

    case "spend.max_actions":
      return state.actions + 1 > c.max
        ? deny(`would exceed the ${c.max}-action limit (this would be ${state.actions + 1})`)
        : permit(`within the ${c.max}-action limit (${state.actions + 1})`);

    case "spend.allowed_payees":
      return c.allowed.some((p) => p.id === request.payee.id)
        ? permit(`payee ${request.payee.id} is on the allow-list`)
        : deny(`payee ${request.payee.id} is not on the allow-list`);

    case "spend.allowed_categories":
      // An uncategorised purchase against a category allow-list is a deny.
      // Treating "unknown" as "permitted" makes the allow-list optional
      // for anyone who omits the field.
      if (request.category === undefined) {
        return deny("purchase has no category, and a category allow-list applies");
      }
      return c.allowed.includes(request.category)
        ? permit(`category ${request.category} is on the allow-list`)
        : deny(`category ${request.category} is not on the allow-list`);

    case "spend.escalation_threshold": {
      if (c.currency !== request.amount.currency) return permit("does not apply: other currency");
      // Not a deny. AP2 defines `unresolved_constraint` as the documented
      // path back to a human, and a mandate that says "ask above ₹20,000"
      // is not refusing the purchase — it is withholding the agent's
      // authority to make it alone.
      return greaterThan(request.amount, money(c.above, c.currency))
        ? {
            id,
            constraint: c.type,
            effect: "escalate",
            detail:
              `${format(request.amount)} is above the ${fmt(c.above, c.currency)} ` +
              `threshold and requires human approval`,
          }
        : permit(`below the ${fmt(c.above, c.currency)} escalation threshold`);
    }

    case "spend.rail":
      return c.allowed.includes(request.rail)
        ? permit(`rail ${request.rail} is permitted`)
        : deny(`rail ${request.rail} is not permitted`);
  }

  return deny(`unknown constraint type ${String((c as { type: string }).type)}`);
}

const fmt = (minor: bigint, currency: CurrencyCode): string => format(money(minor, currency));

function describePermit(
  constraints: readonly Constraint[],
  request: PurchaseRequest,
  state: SpendState,
): string {
  // The audit record is meant to be read by a human who did not write this
  // code, so a permit says which limits it cleared, not merely "permit".
  const cap = constraints.find(
    (c) => c.type === "spend.amount_range" && c.currency === request.amount.currency,
  );
  const budget = constraints.find(
    (c) => c.type === "spend.budget" && c.currency === request.amount.currency,
  );

  const parts = [`${format(request.amount)} to ${request.payee.id} via ${request.rail}`];
  if (cap?.type === "spend.amount_range") {
    parts.push(`within per-transaction cap (${fmt(cap.max, cap.currency)})`);
  }
  if (budget?.type === "spend.budget") {
    parts.push(
      `within aggregate budget (${format(add(state.spent, request.amount))} of ` +
        `${fmt(budget.max, budget.currency)})`,
    );
  }
  return parts.join("; ");
}
