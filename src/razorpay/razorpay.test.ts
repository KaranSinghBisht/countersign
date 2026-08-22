import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { utf8 } from "../crypto/encoding.js";
import { deriveReceipt, isWellFormedReceipt, RECEIPT_MAX_LENGTH } from "./receipt.js";
import { signAsRazorpay, verifyPaymentSignature, verifyWebhookSignature } from "./signature.js";
import { advance, isContradictory, isTerminal, PAYMENT_STATES, rankOf } from "./state.js";

const JTI = "01K3QF8ZZ0CLOSEDMANDATE001";
const HASH = "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8";
const SECRET = "rzp_test_secret_placeholder";

describe("receipt derivation", () => {
  it("fits Razorpay's 40-character field exactly", () => {
    const receipt = deriveReceipt(JTI, HASH);

    expect(receipt).toHaveLength(RECEIPT_MAX_LENGTH);
    expect(receipt.startsWith("pr")).toBe(true);
    expect(isWellFormedReceipt(receipt)).toBe(true);
  });

  it("is deterministic", () => {
    // The entire point: a retry of the same purchase derives the same receipt,
    // so Razorpay can reject the duplicate even if our idempotency has a bug.
    expect(deriveReceipt(JTI, HASH)).toBe(deriveReceipt(JTI, HASH));
  });

  it("differs for a different mandate or a different request", () => {
    const base = deriveReceipt(JTI, HASH);

    expect(deriveReceipt("01K3QF8ZZ0CLOSEDMANDATE002", HASH)).not.toBe(base);
    expect(deriveReceipt(JTI, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).not.toBe(base);
  });

  it("cannot be confused by shifting the boundary between its inputs", () => {
    // Plain concatenation would derive the same receipt for ("ab","c") and
    // ("a","bc"). Both inputs are fixed width today, so this is unreachable —
    // which is exactly why it would survive until the day one of them changes.
    expect(deriveReceipt("ab", "c")).not.toBe(deriveReceipt("a", "bc"));
  });

  it("uses an alphabet safe to read aloud", () => {
    // Crockford base32 omits I, L, O and U.
    const receipts = Array.from({ length: 200 }, (_, i) => deriveReceipt(`jti-${i}`, HASH));

    for (const receipt of receipts) {
      expect(receipt.slice(2)).not.toMatch(/[ILOU]/);
      expect(isWellFormedReceipt(receipt)).toBe(true);
    }
  });

  it("refuses to derive from missing inputs", () => {
    expect(() => deriveReceipt("", HASH)).toThrow();
    expect(() => deriveReceipt(JTI, "")).toThrow();
  });

  it("never collides across distinct inputs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (a, b, c, d) => {
          const same = a === c && b === d;
          const collides = deriveReceipt(a, b) === deriveReceipt(c, d);
          return same === collides;
        },
      ),
    );
  });

  it("rejects malformed receipts", () => {
    expect(isWellFormedReceipt("pr")).toBe(false);
    expect(isWellFormedReceipt(`xx${deriveReceipt(JTI, HASH).slice(2)}`)).toBe(false);
    expect(isWellFormedReceipt(`${deriveReceipt(JTI, HASH)}A`)).toBe(false);
    // Contains letters Crockford excludes.
    expect(isWellFormedReceipt(`pr${"I".repeat(38)}`)).toBe(false);
  });
});

describe("payment signatures", () => {
  const ORDER = "order_MgXyZ1abc";
  const PAYMENT = "pay_MgXyZ2def";

  it("accepts a signature Razorpay would have produced", () => {
    const signature = signAsRazorpay(`${ORDER}|${PAYMENT}`, SECRET);

    expect(verifyPaymentSignature(ORDER, PAYMENT, signature, SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const signature = signAsRazorpay(`${ORDER}|${PAYMENT}`, "someone-elses-secret");

    expect(verifyPaymentSignature(ORDER, PAYMENT, signature, SECRET)).toBe(false);
  });

  it("rejects a signature bound to a different order or payment", () => {
    const signature = signAsRazorpay(`${ORDER}|${PAYMENT}`, SECRET);

    expect(verifyPaymentSignature("order_other", PAYMENT, signature, SECRET)).toBe(false);
    expect(verifyPaymentSignature(ORDER, "pay_other", signature, SECRET)).toBe(false);
  });

  it("refuses ids containing the separator", () => {
    // Otherwise ("a|b", "c") and ("a", "b|c") sign the same string, and a
    // signature over one would verify for the other.
    const signature = signAsRazorpay("a|b|c", SECRET);

    expect(verifyPaymentSignature("a|b", "c", signature, SECRET)).toBe(false);
    expect(verifyPaymentSignature("a", "b|c", signature, SECRET)).toBe(false);
  });

  it("rejects signatures of the wrong length without comparing them", () => {
    expect(verifyPaymentSignature(ORDER, PAYMENT, "", SECRET)).toBe(false);
    expect(verifyPaymentSignature(ORDER, PAYMENT, "abcd", SECRET)).toBe(false);
    expect(
      verifyPaymentSignature(
        ORDER,
        PAYMENT,
        signAsRazorpay(`${ORDER}|${PAYMENT}`, SECRET) + "00",
        SECRET,
      ),
    ).toBe(false);
  });

  it("rejects non-hex input", () => {
    expect(verifyPaymentSignature(ORDER, PAYMENT, "z".repeat(64), SECRET)).toBe(false);
  });

  it("is case-insensitive about hex, since the bytes are what matter", () => {
    const signature = signAsRazorpay(`${ORDER}|${PAYMENT}`, SECRET);

    expect(verifyPaymentSignature(ORDER, PAYMENT, signature.toUpperCase(), SECRET)).toBe(true);
  });
});

describe("webhook signatures", () => {
  const BODY = utf8('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}');

  it("accepts a signature over the exact bytes received", () => {
    expect(verifyWebhookSignature(BODY, signAsRazorpay(BODY, SECRET), SECRET)).toBe(true);
  });

  it("rejects a re-serialised body", () => {
    // The classic failure, and the reason this function takes bytes. A global
    // JSON parser above the route means the handler only ever sees an object,
    // and re-encoding it changes whitespace and key order — so a perfectly
    // valid signature stops verifying and the cause is nowhere near the
    // symptom.
    //
    // Razorpay sends compact JSON; this body has incidental whitespace, so the
    // round trip is guaranteed to produce different bytes for the same value.
    const asSent = utf8('{"event": "payment.captured", "amount": 1000}');
    const signature = signAsRazorpay(asSent, SECRET);

    const reserialised = utf8(JSON.stringify(JSON.parse(new TextDecoder().decode(asSent))));

    expect(new TextDecoder().decode(reserialised)).not.toBe(new TextDecoder().decode(asSent));
    expect(verifyWebhookSignature(asSent, signature, SECRET)).toBe(true);
    expect(verifyWebhookSignature(reserialised, signature, SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = signAsRazorpay(BODY, SECRET);
    const tampered = utf8(new TextDecoder().decode(BODY).replace("pay_1", "pay_2"));

    expect(verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhookSignature(BODY, signAsRazorpay(BODY, "wrong"), SECRET)).toBe(false);
  });

  it("handles an empty body without throwing", () => {
    const empty = new Uint8Array(0);
    expect(verifyWebhookSignature(empty, signAsRazorpay(empty, SECRET), SECRET)).toBe(true);
  });
});

describe("payment state", () => {
  it("advances along the happy path", () => {
    expect(advance("created", "authorized")).toMatchObject({ next: "authorized", applied: true });
    expect(advance("authorized", "captured")).toMatchObject({ next: "captured", applied: true });
    expect(advance("captured", "refunded")).toMatchObject({ next: "refunded", applied: true });
  });

  it("never walks a captured payment backwards", () => {
    // Razorpay does not guarantee authorized arrives before captured, so this
    // is a routine delivery order rather than an exotic case.
    const transition = advance("captured", "authorized");

    expect(transition).toMatchObject({ next: "captured", applied: false });
    expect(transition.reason).toContain("unordered");
  });

  it("believes a capture that arrives after a failure", () => {
    // The deliberate ranking. If Razorpay says money moved, it moved, and
    // recording it as failed would leave a genuinely charged customer looking
    // like a missing payment.
    expect(advance("failed", "captured")).toMatchObject({ next: "captured", applied: true });
    expect(advance("captured", "failed")).toMatchObject({ next: "captured", applied: false });
  });

  it("lets an authorization fail", () => {
    expect(advance("authorized", "failed")).toMatchObject({ next: "failed", applied: true });
    expect(advance("created", "failed")).toMatchObject({ next: "failed", applied: true });
  });

  it("treats a redelivery as a no-op rather than a regression", () => {
    const transition = advance("captured", "captured");

    expect(transition).toMatchObject({ next: "captured", applied: false });
    expect(transition.reason).toContain("duplicate");
  });

  it("flags a refund with no capture behind it", () => {
    expect(isContradictory("authorized", "refunded")).toBe(true);
    expect(isContradictory("captured", "refunded")).toBe(false);
  });

  it("marks the states nothing is expected to follow", () => {
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("captured")).toBe(false);
  });

  it("is monotonic under any delivery order", () => {
    // The property that matters: however the events are shuffled, the state
    // only ever moves up the rank.
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...PAYMENT_STATES), { maxLength: 30 }), (events) => {
        let state: (typeof PAYMENT_STATES)[number] = "created";

        for (const event of events) {
          const before = rankOf(state);
          state = advance(state, event).next;
          if (rankOf(state) < before) return false;
        }

        return true;
      }),
    );
  });

  it("reaches the same state regardless of delivery order", () => {
    // At-least-once and unordered delivery means the same set of events can
    // arrive any way round; the result has to be the same either way.
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...PAYMENT_STATES), { maxLength: 12 }), (events) => {
        const settle = (order: readonly (typeof PAYMENT_STATES)[number][]) =>
          order.reduce<(typeof PAYMENT_STATES)[number]>(
            (state, event) => advance(state, event).next,
            "created",
          );

        return settle(events) === settle([...events].reverse());
      }),
    );
  });

  it("is idempotent under redelivery", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...PAYMENT_STATES), { maxLength: 12 }), (events) => {
        const once = events.reduce<(typeof PAYMENT_STATES)[number]>(
          (state, event) => advance(state, event).next,
          "created",
        );
        const twice = [...events, ...events].reduce<(typeof PAYMENT_STATES)[number]>(
          (state, event) => advance(state, event).next,
          "created",
        );

        return once === twice;
      }),
    );
  });
});
