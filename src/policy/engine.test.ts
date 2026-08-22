import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Constraint, ConstraintSchema } from "../mandate/constraints.js";
import { money, zero } from "../money/money.js";
import { decide, type PurchaseRequest, type SpendState } from "./engine.js";

const parse = (input: unknown): Constraint => ConstraintSchema.parse(input);

const CONSTRAINTS = [
  { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 },
  { type: "spend.budget", currency: "INR", max: 25_000_000 },
  {
    type: "spend.velocity",
    window_seconds: 86_400,
    currency: "INR",
    max_amount: 10_000_000,
    max_count: 5,
  },
  { type: "spend.max_actions", max: 10 },
  { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
  {
    type: "spend.escalation_threshold",
    currency: "INR",
    above: 2_000_000,
    requires: "human_approval",
  },
  { type: "spend.rail", allowed: ["razorpay_order"] },
].map(parse);

const NOW = 1_755_700_500;

const REQUEST: PurchaseRequest = {
  amount: money(1_499_000n, "INR"),
  payee: { id: "vnd_1042" },
  rail: "razorpay_order",
};

const FRESH: SpendState = { spent: zero("INR"), actions: 0, recent: [] };

const run = (
  overrides: Partial<PurchaseRequest> = {},
  state: SpendState = FRESH,
  constraints = CONSTRAINTS,
) => decide(constraints, { ...REQUEST, ...overrides }, state, NOW);

describe("decide: permitting", () => {
  it("permits a purchase inside every limit", () => {
    const d = run();
    expect(d.effect).toBe("permit");
    expect(d.decidedBy).toBeNull();
  });

  it("explains what a permit cleared, not merely that it passed", () => {
    // The audit record is read by someone who did not write this code.
    expect(run().reason).toMatch(/₹14,990\.00.*vnd_1042.*per-transaction cap.*aggregate budget/);
  });

  it("evaluates every rule even when all of them permit", () => {
    expect(run().rules).toHaveLength(CONSTRAINTS.length);
  });
});

describe("decide: denying", () => {
  it("denies above the per-transaction cap", () => {
    const d = run({ amount: money(5_000_001n, "INR") });
    expect(d).toMatchObject({ effect: "deny", decidedBy: "R-AMT-INR" });
    expect(d.reason).toMatch(/per-transaction cap/);
  });

  it("denies when the aggregate budget would be exceeded", () => {
    const state: SpendState = { ...FRESH, spent: money(24_000_000n, "INR") };
    expect(run({}, state)).toMatchObject({ effect: "deny", decidedBy: "R-BUD-INR" });
  });

  it("denies a payee outside the allow-list", () => {
    expect(run({ payee: { id: "vnd_attacker" } })).toMatchObject({
      effect: "deny",
      decidedBy: "R-PAY",
    });
  });

  it("denies a rail outside the allow-list", () => {
    expect(run({ rail: "wire_transfer" })).toMatchObject({ effect: "deny", decidedBy: "R-RAIL" });
  });

  it("denies once the action count is used up", () => {
    expect(run({}, { ...FRESH, actions: 10 })).toMatchObject({
      effect: "deny",
      decidedBy: "R-ACT",
    });
  });

  it("denies an uncategorised purchase when a category allow-list applies", () => {
    // "Unknown" must not read as "permitted", or the allow-list becomes
    // optional for anyone who omits the field.
    const constraints = [
      ...CONSTRAINTS,
      parse({ type: "spend.allowed_categories", allowed: ["office_supplies"] }),
    ];
    expect(run({}, FRESH, constraints)).toMatchObject({ effect: "deny", decidedBy: "R-CAT" });
  });

  it("denies a currency no constraint governs", () => {
    // The mandate bounds INR. Without this check a USD purchase would clear
    // every INR rule vacuously and settle unbounded.
    const d = run({ amount: money(9_999_999n, "USD") });
    expect(d).toMatchObject({ effect: "deny", decidedBy: "R-CUR" });
    expect(d.reason).toMatch(/USD/);
  });
});

describe("decide: velocity", () => {
  const recent = (count: number, at: number) =>
    Array.from({ length: count }, () => ({ at, amount: money(1_000_000n, "INR") }));

  it("counts actions inside the rolling window", () => {
    const state: SpendState = { ...FRESH, recent: recent(5, NOW - 100) };
    expect(run({}, state)).toMatchObject({ effect: "deny", decidedBy: "R-VEL-INR" });
  });

  it("ignores actions that have aged out of the window", () => {
    const state: SpendState = { ...FRESH, recent: recent(5, NOW - 86_401) };
    expect(run({}, state).effect).toBe("permit");
  });

  it("treats the window as half-open at the boundary", () => {
    // Exactly window_seconds old has aged out. Closed on both ends, an
    // action at the boundary could be counted twice depending on which side
    // the comparison landed.
    const atBoundary: SpendState = { ...FRESH, recent: recent(5, NOW - 86_400) };
    expect(run({}, atBoundary).effect).toBe("permit");

    const justInside: SpendState = { ...FRESH, recent: recent(5, NOW - 86_399) };
    expect(run({}, justInside).effect).toBe("deny");
  });

  it("denies on the amount axis independently of the count", () => {
    const state: SpendState = {
      ...FRESH,
      recent: [{ at: NOW - 100, amount: money(9_000_000n, "INR") }],
    };
    expect(run({}, state)).toMatchObject({ effect: "deny", decidedBy: "R-VEL-INR" });
  });
});

describe("decide: escalation", () => {
  it("escalates rather than denying above the threshold", () => {
    // A mandate saying "ask above ₹20,000" is not refusing the purchase. It
    // is withholding the agent's authority to make it alone, and AP2 defines
    // unresolved_constraint as the path back to a human.
    const d = run({ amount: money(3_000_000n, "INR") });
    expect(d).toMatchObject({ effect: "escalate", decidedBy: "R-ESC-INR" });
    expect(d.reason).toMatch(/human approval/);
  });

  it("lets a deny outrank an escalation", () => {
    // Above the escalation threshold AND to a forbidden payee. Escalating
    // would ask a human to approve something the mandate already forbids,
    // turning the approval prompt into a way to widen the mandate.
    const d = run({ amount: money(3_000_000n, "INR"), payee: { id: "vnd_attacker" } });
    expect(d).toMatchObject({ effect: "deny", decidedBy: "R-PAY" });
  });

  it("permits at exactly the threshold", () => {
    expect(run({ amount: money(2_000_000n, "INR") }).effect).toBe("permit");
  });
});

describe("decide: auditability", () => {
  it("records an outcome for every rule, not just the deciding one", () => {
    // A record showing only "denied at R-PAY" cannot answer whether the
    // budget would also have refused, which is what an incident review needs.
    const d = run({ amount: money(99_000_000n, "INR"), payee: { id: "vnd_attacker" } });

    expect(d.rules).toHaveLength(CONSTRAINTS.length);
    expect(d.rules.filter((r) => r.effect === "deny").length).toBeGreaterThan(1);
  });

  it("gives every rule a stable id that survives reordering", () => {
    const forward = run().rules.map((r) => r.id);
    const reversed = decide([...CONSTRAINTS].reverse(), REQUEST, FRESH, NOW).rules.map((r) => r.id);

    expect(reversed).toEqual(forward);
  });
});

describe("decide: purity", () => {
  it("is deterministic across repeated calls", () => {
    expect(run()).toEqual(run());
  });

  it("does not depend on the order constraints arrive in", () => {
    // The verifier receives constraints from a JSON bundle whose ordering we
    // do not control. Two callers agreeing only because both happened to
    // iterate a Map in insertion order is not agreement.
    fc.assert(
      fc.property(
        fc.shuffledSubarray(CONSTRAINTS, { minLength: CONSTRAINTS.length }),
        (shuffled) => {
          expect(decide(shuffled, REQUEST, FRESH, NOW)).toEqual(run());
        },
      ),
    );
  });

  it("does not mutate its arguments", () => {
    const constraints = [...CONSTRAINTS];
    const snapshot = JSON.stringify(constraints, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );

    decide(constraints, REQUEST, FRESH, NOW);

    expect(JSON.stringify(constraints, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      snapshot,
    );
  });

  it("depends on `now` only through the velocity window", () => {
    // If any other rule read the clock, moving time would change a verdict
    // that should be time-invariant — and the verifier replaying an old
    // bundle would disagree with the original decision.
    const withoutVelocity = CONSTRAINTS.filter((c) => c.type !== "spend.velocity");

    expect(decide(withoutVelocity, REQUEST, FRESH, NOW)).toEqual(
      decide(withoutVelocity, REQUEST, FRESH, NOW + 10_000_000),
    );
  });
});
