import { describe, expect, it } from "vitest";
import { REDACTED, redact, scrubString } from "./redact.js";

/** Synthetic. Luhn-valid test PANs from the card networks' published ranges. */
const TEST_PAN = "4111111111111111";
const TEST_PAN_SPACED = "4111 1111 1111 1111";
const TEST_JWT =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfMSIsImV4cCI6OTk5OTk5OTk5OX0.MEUCIQDx7bQ8kZvW3nT2pLm";

/** Serialize the way a logger would, so we test what actually reaches disk. */
const logged = (value: unknown): string => JSON.stringify(redact(value));

describe("allow-list behaviour", () => {
  it("keeps explicitly safe keys", () => {
    expect(redact({ order_id: "order_abc", status: "captured", amount_paise: 149900 })).toEqual({
      order_id: "order_abc",
      status: "captured",
      amount_paise: 149900,
    });
  });

  it("keeps keys matching a safe shape", () => {
    expect(redact({ prompt_sha256: "kR9v", duration_ms: 42, is_captured: true })).toEqual({
      prompt_sha256: "kR9v",
      duration_ms: 42,
      is_captured: true,
    });
  });

  // The whole point. A deny-list would have to anticipate every one of these.
  it("redacts unrecognized keys, whatever they are called", () => {
    const record = {
      email: "a@b.com",
      customerVpa: "karan@okhdfcbank",
      contact: "9876543210",
      shipping_address: "12 MG Road, Bengaluru",
      cardholder: "Karan Singh Bisht",
      some_field_invented_next_tuesday: "anything at all",
      // `name` is a person as often as it is a label, and `message` is where
      // a customer's own words arrive in a conversational checkout.
      name: "Karan Singh Bisht",
      message: "my card is 4111 1111 1111 1111, please just charge it",
    };
    for (const value of Object.values(redact(record) as Record<string, unknown>)) {
      expect(value).toBe(REDACTED);
    }
  });

  // If a rejected key's value were walked, a safe-looking nested key would
  // leak the object we already decided not to log.
  it("does not descend into a rejected key", () => {
    const out = redact({ customer: { status: "active", email: "a@b.com" } }) as Record<
      string,
      unknown
    >;
    expect(out.customer).toBe(REDACTED);
    expect(logged({ customer: { status: "active", email: "a@b.com" } })).not.toContain("active");
  });
});

describe("scrubbing inside allow-listed free text", () => {
  it("removes a compact JWS from a message", () => {
    expect(scrubString(`presented ${TEST_JWT}`)).toBe("presented [redacted:jwt]");
  });

  it("removes an email", () => {
    expect(scrubString("notified karan@example.com")).toBe("notified [redacted:email]");
  });

  it("removes a UPI VPA, which has no dot in the handle", () => {
    expect(scrubString("payer karan@okhdfcbank")).toBe("payer [redacted:vpa]");
  });

  it("removes a Luhn-valid card number, spaced or not", () => {
    expect(scrubString(`card ${TEST_PAN}`)).toBe("card [redacted:pan]");
    expect(scrubString(`card ${TEST_PAN_SPACED}`)).toBe("card [redacted:pan]");
  });

  // Redaction that eats legitimate identifiers gets switched off, so the
  // Luhn check has to earn its keep.
  it("leaves a long digit string that is not a card number", () => {
    expect(scrubString("receipt 1234567890123456")).toContain("1234567890123456");
  });

  it("removes an Indian mobile number with or without country code", () => {
    expect(scrubString("call 9876543210")).toBe("call [redacted:phone]");
    expect(scrubString("call +91 9876543210")).toBe("call [redacted:phone]");
  });

  it("removes an income-tax PAN", () => {
    expect(scrubString("pan ABCDE1234F")).toBe("pan [redacted:tax-pan]");
  });

  it("removes a live API key", () => {
    const liveKey = "rzp_live_AbCdEf123456"; // pragma: allow-live-key (synthetic)
    expect(scrubString(`using ${liveKey}`)).toBe("using [redacted:live-key]");
  });

  it("leaves ordinary text alone", () => {
    const message = "order captured in 42ms after 1 retry";
    expect(scrubString(message)).toBe(message);
  });
});

describe("the payload a real log line would carry", () => {
  // The plan's day-1 acceptance test: feed a synthetic PAN, a JWT and an
  // email through the logger and assert none survive.
  it("lets none of a PAN, a JWT or an email reach the output", () => {
    const output = logged({
      msg: `charging ${TEST_PAN} for karan@example.com with ${TEST_JWT}`,
      order_id: "order_MxYz123",
      customer: { email: "karan@example.com", pan: TEST_PAN },
      mandate: TEST_JWT,
      amount_paise: 149900,
    });

    expect(output).not.toContain(TEST_PAN);
    expect(output).not.toContain("4111");
    expect(output).not.toContain("karan@example.com");
    expect(output).not.toContain(TEST_JWT);
    expect(output).not.toContain("eyJhbGci");

    // ...while still being worth reading.
    expect(output).toContain("order_MxYz123");
    expect(output).toContain("149900");
  });

  it("survives a whole Razorpay payment entity being logged by mistake", () => {
    const razorpayPayment = {
      id: "pay_29QQoUBi66xm2f",
      entity: "payment",
      amount: 100,
      currency: "INR",
      status: "captured",
      method: "card",
      card: { last4: "1111", network: "Visa", name: "Karan Singh Bisht" },
      email: "karan@example.com",
      contact: "+919876543210",
      vpa: "karan@okhdfcbank",
      notes: { address: "12 MG Road, Bengaluru 560001" },
    };

    const output = logged(razorpayPayment);
    for (const leak of [
      "karan@example.com",
      "9876543210",
      "okhdfcbank",
      "MG Road",
      "Karan Singh Bisht",
      "Visa",
    ]) {
      expect(output).not.toContain(leak);
    }
    expect(output).toContain("captured");
  });
});

describe("robustness", () => {
  // A logger that throws inside a catch block destroys the error it was
  // called to report, so redaction must not be able to fail.
  it("stringifies bigint rather than throwing on it", () => {
    expect(redact({ amount_paise: 149900n })).toEqual({ amount_paise: "149900" });
    expect(() => logged({ amount_paise: 149900n })).not.toThrow();
  });

  it("handles a circular reference", () => {
    const node: Record<string, unknown> = { status: "ok" };
    node.self = node;
    expect(() => logged(node)).not.toThrow();
  });

  it("bounds recursion depth", () => {
    let deep: Record<string, unknown> = { status: "leaf" };
    for (let i = 0; i < 50; i++) deep = { state: deep };
    expect(logged(deep)).toContain("[truncated:depth]");
  });

  // Prefixed keys, not name/message/stack: those are not on the allow-list,
  // and this object gets walked a second time on its way through the logger.
  it("scrubs an error message and stack without dropping the error", () => {
    const out = redact(new Error("failed for karan@example.com")) as Record<string, unknown>;
    expect(out.error_name).toBe("Error");
    expect(out.error_message).toBe("failed for [redacted:email]");
    expect(out.error_stack).toContain("Error");
  });

  it("survives being redacted twice, as the logger does to it", () => {
    const once = redact(new Error("failed for karan@example.com"));
    expect(redact({ err: once })).toEqual({
      err: {
        error_name: "Error",
        error_message: "failed for [redacted:email]",
        error_stack: expect.stringContaining("Error"),
      },
    });
  });

  it("truncates very long arrays", () => {
    const out = redact({ count: Array.from({ length: 500 }, (_, i) => i) }) as {
      count: unknown[];
    };
    expect(out.count).toHaveLength(100);
  });

  it("handles primitives and nullish values at the root", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact("plain")).toBe("plain");
  });
});
