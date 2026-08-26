import { describe, expect, it } from "vitest";
import { money } from "../money/money.js";
import { capturePostings, LedgerError, refundPostings, releasePostings } from "./ledger.js";

const sum = (postings: ReturnType<typeof capturePostings>): bigint =>
  postings.reduce((acc, p) => acc + p.amount.amount, 0n);

describe("ledger postings", () => {
  it("capture, release and refund each balance", () => {
    const amount = money(1_499_000n, "INR");
    const fee = money(17_700n, "INR");

    expect(sum(capturePostings(amount, fee))).toBe(0n);
    expect(sum(capturePostings(amount, money(0n, "INR")))).toBe(0n);
    expect(sum(releasePostings(amount))).toBe(0n);
    expect(sum(refundPostings(amount, fee))).toBe(0n);
    expect(sum(refundPostings(amount, money(0n, "INR")))).toBe(0n);
  });

  it("refuses a fee in a different currency", () => {
    expect(() => capturePostings(money(100n, "INR"), money(1n, "USD"))).toThrow(LedgerError);
    expect(() => refundPostings(money(100n, "INR"), money(1n, "USD"))).toThrow(LedgerError);
  });
});
