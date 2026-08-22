/**
 * Spending constraints and the attenuation predicate.
 *
 * A mandate chain is only useful if authority can shrink but never grow. This
 * module owns that single question: given a parent's constraint set and a
 * child's, is the child strictly no more permissive?
 *
 * Three rules govern every answer here, and all three are fail-closed:
 *
 *   1. An unknown constraint type is a DENY, never a pass. A verifier that
 *      skips what it does not recognise can be widened by inventing a
 *      constraint type — so parsing rejects unknown types outright.
 *
 *   2. A constraint the parent set and the child omits is a DENY. This is the
 *      classic delegation bug: absent reads naturally as "unconstrained", so
 *      the narrowing check passes vacuously and the child ends up with more
 *      authority than its parent. Omission is widening.
 *
 *   3. Narrowing is decided conservatively. Where a comparison is not
 *      obviously sound, this module answers "does not narrow" rather than
 *      reasoning cleverly. A wrongly-rejected delegation is an error message;
 *      a wrongly-accepted one is unauthorised spend.
 */

import { z } from "zod";
import { CURRENCIES, type CurrencyCode } from "../money/money.js";

/**
 * A non-negative integer count of minor units, on the wire as a JSON number.
 *
 * AP2's schema says integer minor units while its own amount_range and budget
 * examples show decimals — a spec bug we deliberately do not inherit, so a
 * decimal bound is rejected rather than rounded. Parsed to bigint immediately
 * so no arithmetic downstream can touch a float.
 *
 * Bounds stay within the safe integer range because they arrive as JSON
 * numbers, and a JSON number above 2^53 has already lost precision by the time
 * we see it. That ceiling is ~₹90 trillion, so it does not bind in practice.
 */
const MinorAmount = z
  .number()
  .refine(Number.isInteger, "must be an integer count of minor units, not a decimal amount")
  .refine(Number.isSafeInteger, "exceeds the range where a JSON number is exact")
  .refine((n) => n >= 0, "must not be negative")
  .transform((n) => BigInt(n));

const Currency = z.enum(CURRENCIES);

const PositiveInt = z
  .number()
  .refine(Number.isSafeInteger, "must be an integer")
  .refine((n) => n > 0, "must be positive");

const PayeeRef = z.object({ id: z.string().min(1) }).strict();

/**
 * Every constraint type, as a closed discriminated union.
 *
 * Closed is the point: `z.discriminatedUnion` rejects an unrecognised `type`,
 * so rule 1 is enforced by the parser rather than by a `default:` branch
 * someone can forget to write.
 */
export const ConstraintSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("spend.amount_range"),
      currency: Currency,
      min: MinorAmount,
      max: MinorAmount,
    })
    .strict()
    .refine((c) => c.min <= c.max, "min must not exceed max"),

  z
    .object({
      type: z.literal("spend.budget"),
      currency: Currency,
      max: MinorAmount,
    })
    .strict(),

  z
    .object({
      type: z.literal("spend.velocity"),
      window_seconds: PositiveInt,
      currency: Currency,
      max_amount: MinorAmount,
      max_count: PositiveInt,
    })
    .strict(),

  z
    .object({
      type: z.literal("spend.max_actions"),
      max: PositiveInt,
    })
    .strict(),

  z
    .object({
      type: z.literal("spend.allowed_payees"),
      allowed: z.array(PayeeRef).min(1),
    })
    .strict(),

  z
    .object({
      type: z.literal("spend.allowed_categories"),
      allowed: z.array(z.string().min(1)).min(1),
    })
    .strict(),

  z
    .object({
      type: z.literal("spend.escalation_threshold"),
      currency: Currency,
      above: MinorAmount,
      requires: z.literal("human_approval"),
    })
    .strict(),

  z
    .object({
      type: z.literal("spend.rail"),
      allowed: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

export type Constraint = z.infer<typeof ConstraintSchema>;
export type ConstraintType = Constraint["type"];

/**
 * The identity under which a parent and child constraint are compared.
 *
 * Currency is part of the key because a cap in INR says nothing about a cap in
 * USD. Without it, a child could "narrow" an INR budget by declaring a small
 * USD one and spend rupees unchecked.
 */
export function constraintKey(c: Constraint): string {
  return "currency" in c ? `${c.type}:${c.currency}` : c.type;
}

const subsetOf = (child: readonly string[], parent: readonly string[]): boolean => {
  const permitted = new Set(parent);
  return child.every((value) => permitted.has(value));
};

/**
 * Is `child` no more permissive than `parent`, for one constraint?
 *
 * Callers must have already established that the two share a `constraintKey`,
 * so the type and currency match.
 */
function narrowsOne(parent: Constraint, child: Constraint): boolean {
  switch (parent.type) {
    // The permitted interval must sit inside the parent's. Raising `min`
    // narrows just as lowering `max` does.
    case "spend.amount_range":
      return child.type === parent.type && child.min >= parent.min && child.max <= parent.max;

    case "spend.budget":
      return child.type === parent.type && child.max <= parent.max;

    // Velocity narrows on three axes at once, and the window is the
    // counter-intuitive one: a SHORTER window is more permissive, because
    // the same cap refills more often. ₹100/hour outspends ₹100/day by 24x.
    //
    // Requiring window_seconds to grow is sufficient but not necessary — it
    // rejects some genuinely narrower windows, e.g. ₹1/hour under ₹100/day.
    // Per rule 3 that trade is deliberate: the cost is a rejected
    // delegation, and the alternative is reasoning about rate equivalence
    // in a security check.
    case "spend.velocity":
      return (
        child.type === parent.type &&
        child.max_amount <= parent.max_amount &&
        child.max_count <= parent.max_count &&
        child.window_seconds >= parent.window_seconds
      );

    case "spend.max_actions":
      return child.type === parent.type && child.max <= parent.max;

    case "spend.allowed_payees":
      return (
        child.type === parent.type &&
        subsetOf(
          child.allowed.map((p) => p.id),
          parent.allowed.map((p) => p.id),
        )
      );

    case "spend.allowed_categories":
      return child.type === parent.type && subsetOf(child.allowed, parent.allowed);

    // A LOWER threshold narrows: it sends more transactions to a human.
    // Raising it lets the agent act alone on larger amounts, which is
    // widening even though the number grew.
    case "spend.escalation_threshold":
      return child.type === parent.type && child.above <= parent.above;

    case "spend.rail":
      return child.type === parent.type && subsetOf(child.allowed, parent.allowed);
  }
}

export type AttenuationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly constraint: string };

/**
 * Does the child constraint set attenuate the parent's?
 *
 * Permitted: keeping a constraint identical, tightening it, or adding one the
 * parent never had. Refused: dropping one, loosening one, or duplicating a key
 * so that which copy applies becomes ambiguous.
 */
export function narrows(
  parent: readonly Constraint[],
  child: readonly Constraint[],
): AttenuationResult {
  const parentByKey = indexByKey(parent);
  if (!parentByKey.ok) return parentByKey;

  const childByKey = indexByKey(child);
  if (!childByKey.ok) return childByKey;

  for (const [key, parentConstraint] of parentByKey.index) {
    const childConstraint = childByKey.index.get(key);

    // Rule 2. Absent is not unlimited.
    if (childConstraint === undefined) {
      return {
        ok: false,
        reason:
          "the child drops a constraint the parent set, which would widen authority. " +
          "A constraint the parent imposed must be carried forward or tightened.",
        constraint: key,
      };
    }

    if (!narrowsOne(parentConstraint, childConstraint)) {
      return {
        ok: false,
        reason: "the child loosens a constraint the parent set",
        constraint: key,
      };
    }
  }

  return { ok: true };
}

function indexByKey(
  constraints: readonly Constraint[],
):
  | { readonly ok: true; readonly index: ReadonlyMap<string, Constraint> }
  | { readonly ok: false; readonly reason: string; readonly constraint: string } {
  const index = new Map<string, Constraint>();

  for (const constraint of constraints) {
    const key = constraintKey(constraint);

    // Two constraints under one key make the effective limit depend on
    // evaluation order, and an attacker picks the order. Reject instead of
    // silently taking the first or the last.
    if (index.has(key)) {
      return {
        ok: false,
        reason: "duplicate constraint: which one applies would depend on evaluation order",
        constraint: key,
      };
    }
    index.set(key, constraint);
  }

  return { ok: true, index };
}

/**
 * The effective constraint set: everything from both, tightest wins.
 *
 * Used at decision time rather than trusting the child alone. `narrows` should
 * already guarantee the child is tighter everywhere the two overlap, so this
 * is defence in depth — if the attenuation check ever has a gap, enforcement
 * still applies the parent's limit.
 */
export function effective(
  parent: readonly Constraint[],
  child: readonly Constraint[],
): readonly Constraint[] {
  const merged = new Map<string, Constraint>();

  for (const constraint of parent) merged.set(constraintKey(constraint), constraint);

  for (const constraint of child) {
    const key = constraintKey(constraint);
    const existing = merged.get(key);
    if (existing === undefined || narrowsOne(existing, constraint)) {
      merged.set(key, constraint);
    }
  }

  return [...merged.values()];
}

export const CONSTRAINT_TYPES: readonly ConstraintType[] = [
  "spend.amount_range",
  "spend.budget",
  "spend.velocity",
  "spend.max_actions",
  "spend.allowed_payees",
  "spend.allowed_categories",
  "spend.escalation_threshold",
  "spend.rail",
] as const;

export type { CurrencyCode };
