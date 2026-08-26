import { describe, expect, it } from "vitest";
import { CartSchema, PurchaseBodySchema } from "./purchase.js";

describe("purchase body", () => {
  const cart = {
    total_paise: 1_499_000,
    currency: "INR" as const,
    payee: { id: "vnd_1042" },
    rail: "razorpay_order",
  };

  it("rejects an extra pricing field", () => {
    expect(CartSchema.safeParse({ ...cart, discount_percent: 90 }).success).toBe(false);
  });

  it("requires actor, nonce, chain and cart", () => {
    const parsed = PurchaseBodySchema.safeParse({
      actor_id: "usr_1",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      open_jws: "a.b.c",
      closed_jws: "d.e.f",
      cart,
      proposal: {
        amount_paise: 1_499_000,
        currency: "INR",
        payee: { id: "vnd_1042" },
        rail: "razorpay_order",
      },
    });
    expect(parsed.success).toBe(true);
  });
});
