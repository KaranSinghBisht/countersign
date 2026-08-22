import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_TYPES,
  type Constraint,
  ConstraintSchema,
  constraintKey,
  effective,
  narrows,
} from "./constraints.js";

const parse = (input: unknown): Constraint => ConstraintSchema.parse(input);

const AMOUNT_RANGE = { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 };
const BUDGET = { type: "spend.budget", currency: "INR", max: 25_000_000 };
const VELOCITY = {
  type: "spend.velocity",
  window_seconds: 86_400,
  currency: "INR",
  max_amount: 10_000_000,
  max_count: 5,
};
const MAX_ACTIONS = { type: "spend.max_actions", max: 10 };
const PAYEES = { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }, { id: "vnd_77" }] };
const ESCALATION = {
  type: "spend.escalation_threshold",
  currency: "INR",
  above: 2_000_000,
  requires: "human_approval",
};
const RAIL = { type: "spend.rail", allowed: ["razorpay_order", "upi_reserve_pay"] };

const ALL = [AMOUNT_RANGE, BUDGET, VELOCITY, MAX_ACTIONS, PAYEES, ESCALATION, RAIL];

/** Parent set with one constraint swapped for a modified copy. */
function withOverride(override: Record<string, unknown>): Constraint[] {
  return ALL.map((c) => (c.type === override.type ? parse(override) : parse(c)));
}

const parentSet = (): Constraint[] => ALL.map(parse);

describe("constraint parsing", () => {
  it("rejects an unrecognised constraint type rather than ignoring it", () => {
    // A verifier that skips what it does not recognise can be widened by
    // inventing a type. Fail closed at the parser.
    expect(() => parse({ type: "spend.unlimited", max: 1 })).toThrow();
    expect(() => parse({ type: "spend.amount_rage", currency: "INR", min: 0, max: 1 })).toThrow();
  });

  it("rejects a decimal bound instead of rounding it", () => {
    // AP2's own examples show decimals here. Inheriting that would make
    // ₹5,000.50 silently become a different limit than the human approved.
    expect(() => parse({ ...AMOUNT_RANGE, max: 5_000_000.5 })).toThrow(/integer/i);
  });

  it("rejects a negative bound", () => {
    expect(() => parse({ ...BUDGET, max: -1 })).toThrow(/negative/i);
  });

  it("rejects an inverted range", () => {
    expect(() => parse({ ...AMOUNT_RANGE, min: 100, max: 50 })).toThrow(/max/i);
  });

  it("rejects unknown fields, so a stray key cannot ride along unnoticed", () => {
    expect(() => parse({ ...BUDGET, max_amount: 99_999_999 })).toThrow();
  });

  it("keeps currency in the comparison key", () => {
    expect(constraintKey(parse(BUDGET))).toBe("spend.budget:INR");
    expect(constraintKey(parse(MAX_ACTIONS))).toBe("spend.max_actions");
  });

  it("covers every declared constraint type", () => {
    expect(new Set(ALL.map((c) => c.type))).toEqual(
      new Set(CONSTRAINT_TYPES.filter((t) => t !== "spend.allowed_categories")),
    );
  });
});

describe("narrows: the identity case", () => {
  it("accepts a child identical to its parent", () => {
    expect(narrows(parentSet(), parentSet())).toEqual({ ok: true });
  });

  it("accepts a child that adds a constraint the parent never set", () => {
    const child = [
      ...parentSet(),
      parse({ type: "spend.allowed_categories", allowed: ["office_supplies"] }),
    ];
    expect(narrows(parentSet(), child)).toEqual({ ok: true });
  });
});

// The plan calls out six specific widening attempts. Each gets a named test,
// because a regression in any one of them is unauthorised spend rather than a
// failing assertion.
describe("narrows: refuses every widening attempt", () => {
  it("a bigger per-transaction cap", () => {
    const child = withOverride({ ...AMOUNT_RANGE, max: 5_000_001 });
    expect(narrows(parentSet(), child)).toMatchObject({ ok: false });
  });

  it("a lower floor on the permitted range", () => {
    const parent = withOverride({ ...AMOUNT_RANGE, min: 100 });
    const child = withOverride({ ...AMOUNT_RANGE, min: 99 });
    expect(narrows(parent, child)).toMatchObject({ ok: false });
  });

  it("a bigger aggregate budget", () => {
    expect(narrows(parentSet(), withOverride({ ...BUDGET, max: 25_000_001 }))).toMatchObject({
      ok: false,
    });
  });

  it("a REMOVED cap — absent must not read as unlimited", () => {
    // The classic delegation bug. `narrows` must not pass vacuously just
    // because there is nothing on the child side to compare against.
    const child = parentSet().filter((c) => c.type !== "spend.budget");
    const result = narrows(parentSet(), child);

    expect(result).toMatchObject({ ok: false, constraint: "spend.budget:INR" });
    if (!result.ok) expect(result.reason).toMatch(/drops a constraint/);
  });

  it("a payee the parent never allowed", () => {
    const child = withOverride({
      ...PAYEES,
      allowed: [{ id: "vnd_1042" }, { id: "vnd_attacker" }],
    });
    expect(narrows(parentSet(), child)).toMatchObject({ ok: false });
  });

  it("a rail the parent never allowed", () => {
    const child = withOverride({ ...RAIL, allowed: ["razorpay_order", "wire_transfer"] });
    expect(narrows(parentSet(), child)).toMatchObject({ ok: false });
  });

  it("more actions than the parent permitted", () => {
    expect(narrows(parentSet(), withOverride({ ...MAX_ACTIONS, max: 11 }))).toMatchObject({
      ok: false,
    });
  });

  it("a RAISED escalation threshold, even though the number grew", () => {
    // Raising the threshold means fewer transactions reach a human. The
    // number going up is the agent acquiring authority, not losing it.
    expect(narrows(parentSet(), withOverride({ ...ESCALATION, above: 2_000_001 }))).toMatchObject({
      ok: false,
    });
  });

  it("a SHORTER velocity window, which refills the cap more often", () => {
    // ₹1,00,000/hour outspends ₹1,00,000/day by 24x while looking identical
    // on the amount axis.
    const child = withOverride({ ...VELOCITY, window_seconds: 3_600 });
    expect(narrows(parentSet(), child)).toMatchObject({ ok: false });
  });

  it("a higher velocity count at the same window", () => {
    expect(narrows(parentSet(), withOverride({ ...VELOCITY, max_count: 6 }))).toMatchObject({
      ok: false,
    });
  });

  it("a cap re-denominated into another currency", () => {
    // Without currency in the key this passes: a small USD budget appears to
    // narrow the INR one, and rupee spend is then unconstrained.
    const child = [
      ...parentSet().filter((c) => c.type !== "spend.budget"),
      parse({ type: "spend.budget", currency: "USD", max: 1 }),
    ];

    expect(narrows(parentSet(), child)).toMatchObject({
      ok: false,
      constraint: "spend.budget:INR",
    });
  });

  it("a duplicate key, where the applicable limit depends on evaluation order", () => {
    const child = [...parentSet(), parse({ ...BUDGET, max: 1 })];
    const result = narrows(parentSet(), child);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/duplicate/);
  });
});

describe("narrows: accepts genuine tightening", () => {
  it.each([
    ["a smaller per-transaction cap", { ...AMOUNT_RANGE, max: 1_000_000 }],
    ["a raised floor", { ...AMOUNT_RANGE, min: 1_000 }],
    ["a smaller budget", { ...BUDGET, max: 1_000_000 }],
    ["fewer actions", { ...MAX_ACTIONS, max: 1 }],
    ["a lowered escalation threshold", { ...ESCALATION, above: 1 }],
    ["a longer velocity window", { ...VELOCITY, window_seconds: 172_800 }],
    ["a smaller velocity amount", { ...VELOCITY, max_amount: 1 }],
    ["a narrowed payee list", { ...PAYEES, allowed: [{ id: "vnd_1042" }] }],
    ["a narrowed rail list", { ...RAIL, allowed: ["razorpay_order"] }],
  ])("%s", (_label, override) => {
    expect(narrows(parentSet(), withOverride(override))).toEqual({ ok: true });
  });
});

describe("effective", () => {
  it("keeps the parent's limit when the child is somehow looser", () => {
    // Defence in depth: if `narrows` ever has a gap, enforcement must still
    // apply the tighter of the two rather than whatever the child claimed.
    const looser = withOverride({ ...BUDGET, max: 999_999_999 });
    const merged = effective(parentSet(), looser);
    const budget = merged.find((c) => c.type === "spend.budget");

    expect(budget).toMatchObject({ max: 25_000_000n });
  });

  it("adopts the child's limit when it is tighter", () => {
    const merged = effective(parentSet(), withOverride({ ...BUDGET, max: 1_000 }));
    expect(merged.find((c) => c.type === "spend.budget")).toMatchObject({ max: 1_000n });
  });

  it("carries constraints only the child declares", () => {
    const child = [
      ...parentSet(),
      parse({ type: "spend.allowed_categories", allowed: ["office_supplies"] }),
    ];
    expect(effective(parentSet(), child).some((c) => c.type === "spend.allowed_categories")).toBe(
      true,
    );
  });
});

describe("narrows: algebraic properties", () => {
  const budgetArb = fc
    .integer({ min: 0, max: 1_000_000 })
    .map((max) => parse({ type: "spend.budget", currency: "INR", max }));

  const equalBound = (a: Constraint, b: Constraint): boolean =>
    a.type === "spend.budget" && b.type === "spend.budget" && a.max === b.max;

  it("is reflexive — a set always narrows itself", () => {
    fc.assert(
      fc.property(budgetArb, (c) => {
        expect(narrows([c], [c])).toEqual({ ok: true });
      }),
    );
  });

  it("is transitive — narrowing twice still narrows", () => {
    // This is what makes a chain safe. Without transitivity, a depth-2 chain
    // could end up wider than its root while each individual hop looked
    // legitimate.
    fc.assert(
      fc.property(budgetArb, budgetArb, budgetArb, (a, b, c) => {
        fc.pre(narrows([a], [b]).ok && narrows([b], [c]).ok);
        expect(narrows([a], [c])).toEqual({ ok: true });
      }),
    );
  });

  it("is antisymmetric — mutual narrowing holds exactly when the bounds are equal", () => {
    // Stated without a precondition on purpose. Filtering for pairs that
    // narrow each other would discard almost every generated case, since two
    // independent integers are rarely equal, and the test would pass on a
    // handful of samples. As a biconditional it checks something on every
    // run: strictly-smaller must narrow in one direction only.
    fc.assert(
      fc.property(budgetArb, budgetArb, (a, b) => {
        const mutual = narrows([a], [b]).ok && narrows([b], [a]).ok;
        expect(mutual).toBe(constraintKey(a) === constraintKey(b) && equalBound(a, b));
      }),
    );
  });
});
