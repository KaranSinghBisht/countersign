/**
 * RBI localization, as a test.
 *
 * An LLM API call is processing. If a prompt contains payment system data
 * and the model is abroad, we have sent that data out of India. The
 * projection is the allow-list; this file is the proof it holds against a
 * fixture that tries to smuggle everything we refuse to send.
 */

import { describe, expect, it } from "vitest";
import { projectForPrompt, renderPrompt } from "../src/prompt/projection.js";

/** Luhn-valid test PAN from the published Visa range. Not a real card. */
const TEST_PAN = "4111111111111111";

const DIRTY: Record<string, unknown> = {
  internal_order_id: "ord_internal_01K3QF",
  skus: ["SKU-118", "SKU-220"],
  amount_paise: 1_499_000n,
  currency: "INR",
  status: "captured",

  // Everything below must be dropped. Names, contacts, a VPA, a PAN, a
  // Razorpay payment id, an address — the fields an LLM would most like
  // and the ones localization most forbids.
  customer_name: "Karan Singh Bisht",
  email: "karan@example.com",
  phone: "9876543210",
  address: "12 MG Road, Bengaluru 560001",
  customerVpa: "karan@okhdfcbank",
  pan: TEST_PAN,
  card: "4111 1111 1111 1111",
  payment_id: "pay_MgXyZ2def",
  razorpay_payment_id: "pay_MgXyZ2def",
  order_id: "order_MgXyZ1abc",
};

const PII = [
  /Karan/i,
  /Singh/,
  /karan@example\.com/i,
  /9876543210/,
  /MG Road/,
  /okhdfcbank/i,
  /4111/,
  /pay_MgXyZ2def/,
  /order_MgXyZ1abc/,
];

describe("prompt projection", () => {
  it("keeps only the allow-listed fields", () => {
    expect(projectForPrompt(DIRTY)).toEqual({
      internal_order_id: "ord_internal_01K3QF",
      skus: ["SKU-118", "SKU-220"],
      amount_paise: "1499000",
      currency: "INR",
      status: "captured",
    });
  });

  it("renders nothing that looks like PII or a Razorpay id", () => {
    const text = renderPrompt(projectForPrompt(DIRTY));
    for (const pattern of PII) {
      expect(text, `survived: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("refuses a status that is not coarse", () => {
    expect(() => projectForPrompt({ ...DIRTY, status: "charged_to_card" })).toThrow(
      /coarse status/,
    );
  });
});
