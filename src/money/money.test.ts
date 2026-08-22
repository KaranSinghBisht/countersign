import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  add,
  allocate,
  allocateEvenly,
  CurrencyMismatchError,
  compare,
  format,
  type Money,
  MoneyError,
  money,
  multiply,
  negate,
  parseMoney,
  subtract,
  sum,
  toJSON,
  zero,
} from "./money.js";

// Property tests run with a fixed seed so a failure is reproducible from the
// CI log alone, and so the suite cannot go red for a reason unrelated to the
// commit under test.
fc.configureGlobal({ seed: 0x70726d6e, numRuns: 500 });

/** Arbitrary paise amount spanning roughly ±₹92 quadrillion. */
const paise = (opts?: { min?: bigint; max?: bigint }) =>
  fc.bigInt({ min: opts?.min ?? -(10n ** 15n), max: opts?.max ?? 10n ** 15n });

const nonNegativePaise = () => paise({ min: 0n, max: 10n ** 15n });

const weights = () =>
  fc
    .array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 12 })
    .filter((ws) => ws.reduce((a, b) => a + b, 0n) > 0n);

const inr = (n: bigint): Money => money(n, "INR");

describe("money construction", () => {
  it("rejects a non-bigint amount", () => {
    // @ts-expect-error deliberately violating the type to test the runtime guard
    expect(() => money(100, "INR")).toThrow(MoneyError);
  });

  it("rejects an unsupported currency", () => {
    // @ts-expect-error deliberately violating the type to test the runtime guard
    expect(() => money(100n, "XYZ")).toThrow(MoneyError);
  });

  it("accepts negative amounts, which refunds and reversals need", () => {
    expect(inr(-5000n).amount).toBe(-5000n);
  });
});

describe("parseMoney", () => {
  it("accepts an integer minor-unit amount", () => {
    expect(parseMoney({ amount: 149900, currency: "INR" })).toEqual(inr(149900n));
  });

  it("accepts a bigint amount", () => {
    expect(parseMoney({ amount: 149900n, currency: "INR" })).toEqual(inr(149900n));
  });

  // The 100x bug class: an agent sends rupees where paise are expected. We
  // must reject rather than guess, because guessing wrong moves real money.
  it("rejects a decimal amount instead of silently scaling it", () => {
    expect(() => parseMoney({ amount: 1499.0, currency: "INR" })).not.toThrow();
    expect(() => parseMoney({ amount: 1499.5, currency: "INR" })).toThrow(/integer/);
    expect(() => parseMoney({ amount: 49.99, currency: "INR" })).toThrow(/integer/);
  });

  it("rejects a string amount", () => {
    expect(() => parseMoney({ amount: "149900", currency: "INR" })).toThrow(MoneyError);
  });

  it("rejects an amount beyond the safe integer range", () => {
    expect(() => parseMoney({ amount: 2 ** 53, currency: "INR" })).toThrow(/safe integer/);
  });

  it("rejects a missing or unknown currency", () => {
    expect(() => parseMoney({ amount: 100 })).toThrow(MoneyError);
    expect(() => parseMoney({ amount: 100, currency: "GBP" })).toThrow(MoneyError);
  });

  it("rejects non-objects", () => {
    for (const bad of [null, undefined, 42, "100 INR", []]) {
      expect(() => parseMoney(bad)).toThrow(MoneyError);
    }
  });
});

describe("arithmetic", () => {
  it("refuses to combine different currencies", () => {
    expect(() => add(inr(100n), money(100n, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => subtract(inr(100n), money(100n, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => compare(inr(100n), money(100n, "USD"))).toThrow(CurrencyMismatchError);
  });

  it("is exact at magnitudes where floats are not", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. In paise it is simply 10 + 20 === 30.
    expect(add(inr(10n), inr(20n))).toEqual(inr(30n));

    // Accumulating a tenth of a rupee a million times drifts under floats.
    let acc = zero("INR");
    for (let i = 0; i < 1_000_000; i++) acc = add(acc, inr(10n));
    expect(acc.amount).toBe(10_000_000n);
  });

  it("is associative and commutative under addition", () => {
    fc.assert(
      fc.property(paise(), paise(), paise(), (a, b, c) => {
        const left = add(add(inr(a), inr(b)), inr(c));
        const right = add(inr(a), add(inr(b), inr(c)));
        expect(left).toEqual(right);
        expect(add(inr(a), inr(b))).toEqual(add(inr(b), inr(a)));
      }),
    );
  });

  it("subtracting is adding the negation", () => {
    fc.assert(
      fc.property(paise(), paise(), (a, b) => {
        expect(subtract(inr(a), inr(b))).toEqual(add(inr(a), negate(inr(b))));
      }),
    );
  });

  it("sums a list of line items", () => {
    fc.assert(
      fc.property(fc.array(paise(), { maxLength: 50 }), (amounts) => {
        const total = sum(
          amounts.map((a) => inr(a)),
          "INR",
        );
        expect(total.amount).toBe(amounts.reduce((a, b) => a + b, 0n));
      }),
    );
  });

  it("multiplies by an integer quantity", () => {
    expect(multiply(inr(14900n), 3n)).toEqual(inr(44700n));
    expect(multiply(inr(14900n), 0n)).toEqual(inr(0n));
  });
});

describe("allocate", () => {
  // THE invariant. If this ever fails, money is being created or destroyed.
  it("conserves the total exactly, for any total and any weights", () => {
    fc.assert(
      fc.property(paise(), weights(), (total, ws) => {
        const parts = allocate(inr(total), ws);
        const recombined = parts.reduce((acc, p) => acc + p.amount, 0n);
        expect(recombined).toBe(total);
      }),
    );
  });

  it("returns one part per weight, all in the original currency", () => {
    fc.assert(
      fc.property(nonNegativePaise(), weights(), (total, ws) => {
        const parts = allocate(money(total, "JPY"), ws);
        expect(parts).toHaveLength(ws.length);
        expect(parts.every((p) => p.currency === "JPY")).toBe(true);
      }),
    );
  });

  it("never produces a negative part from a non-negative total", () => {
    fc.assert(
      fc.property(nonNegativePaise(), weights(), (total, ws) => {
        expect(allocate(inr(total), ws).every((p) => p.amount >= 0n)).toBe(true);
      }),
    );
  });

  it("never produces a positive part from a non-positive total", () => {
    fc.assert(
      fc.property(nonNegativePaise(), weights(), (magnitude, ws) => {
        expect(allocate(inr(-magnitude), ws).every((p) => p.amount <= 0n)).toBe(true);
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(paise(), weights(), (total, ws) => {
        expect(allocate(inr(total), ws)).toEqual(allocate(inr(total), ws));
      }),
    );
  });

  it("negating the total negates each part", () => {
    fc.assert(
      fc.property(nonNegativePaise(), weights(), (total, ws) => {
        const positive = allocate(inr(total), ws);
        const negative = allocate(inr(-total), ws);
        expect(negative).toEqual(positive.map(negate));
      }),
    );
  });

  it("gives the odd unit to the largest remainder, not to list order", () => {
    // 5 paise split 70/30: exact shares are 3.5 and 1.5. Both remainders are
    // equal, so the index tiebreak applies and the first bucket wins.
    expect(allocate(inr(5n), [70n, 30n]).map((p) => p.amount)).toEqual([4n, 1n]);

    // 10 paise split 1/1/1: shares 3.33 each, one paisa left over.
    expect(allocate(inr(10n), [1n, 1n, 1n]).map((p) => p.amount)).toEqual([4n, 3n, 3n]);

    // The asymmetric case where largest-remainder and list-order disagree:
    // exact shares are 0.5, 2.5, 4.0 — the odd unit belongs to a bucket with
    // a 0.5 remainder, and index order picks the first of them.
    expect(allocate(inr(7n), [1n, 5n, 8n]).map((p) => p.amount)).toEqual([1n, 2n, 4n]);
  });

  it("handles a total too small to split fairly", () => {
    // One paisa across three recipients. Somebody gets it; nobody loses it.
    const parts = allocate(inr(1n), [1n, 1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([1n, 0n, 0n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(1n);
  });

  it("tolerates zero weights without dropping units", () => {
    const parts = allocate(inr(100n), [0n, 1n, 0n]);
    expect(parts.map((p) => p.amount)).toEqual([0n, 100n, 0n]);
  });

  it("rejects degenerate inputs", () => {
    expect(() => allocate(inr(100n), [])).toThrow(/zero buckets/);
    expect(() => allocate(inr(100n), [0n, 0n])).toThrow(/positive value/);
    expect(() => allocate(inr(100n), [-1n, 2n])).toThrow(/non-negative/);
  });

  it("allocateEvenly conserves the total", () => {
    fc.assert(
      fc.property(paise(), fc.integer({ min: 1, max: 20 }), (total, n) => {
        const parts = allocateEvenly(inr(total), n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(total);
      }),
    );
  });

  it("allocateEvenly rejects a non-positive bucket count", () => {
    expect(() => allocateEvenly(inr(100n), 0)).toThrow(MoneyError);
    expect(() => allocateEvenly(inr(100n), 2.5)).toThrow(MoneyError);
  });
});

describe("serialization", () => {
  it("emits the amount as a string so JSON cannot lose precision", () => {
    expect(toJSON(inr(149900n))).toEqual({ amount: "149900", currency: "INR" });
    const huge = inr(9_007_199_254_740_993n); // MAX_SAFE_INTEGER + 2
    expect(JSON.parse(JSON.stringify(toJSON(huge))).amount).toBe("9007199254740993");
  });
});

describe("format", () => {
  it("renders two-decimal currencies", () => {
    expect(format(inr(149900n))).toMatch(/1,499\.00/);
    expect(format(inr(5n))).toMatch(/0\.05/);
    expect(format(inr(0n))).toMatch(/0\.00/);
  });

  it("renders zero-decimal currencies without a fraction", () => {
    expect(format(money(1499n, "JPY"), "en-US")).toMatch(/1,499/);
    expect(format(money(1499n, "JPY"), "en-US")).not.toMatch(/\./);
  });

  it("renders negatives", () => {
    expect(format(inr(-149900n))).toMatch(/1,499\.00/);
    expect(format(inr(-149900n))).toMatch(/-|\(/);
  });
});
