import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { digestJson } from "../../src/crypto/digest.js";
import type { Sql } from "../../src/db/client.js";
import { balanceOf, ensureAccounts } from "../../src/ledger/ledger.js";
import { money } from "../../src/money/money.js";
import { RazorpayTimeout } from "../../src/razorpay/client.js";
import { fakeRazorpay, seedPayment } from "../../src/razorpay/fake.js";
import { ofStream } from "../../src/razorpay/outbox.js";
import { deriveReceipt } from "../../src/razorpay/receipt.js";
import { adoptRemoteState, reconcile } from "../../src/razorpay/reconcile.js";
import { drain, drainOne, intendPayment } from "../../src/razorpay/settle.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;

const INR = "INR" as const;
const AMOUNT = 10_000n;
const HASH = "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8";

async function intend(overrides: { closedJti?: string; outboxId?: string } = {}) {
  const closedJti = overrides.closedJti ?? testId();
  const authorizationId = testId();
  const outboxId = overrides.outboxId ?? testId();

  const intended = await sql.begin((tx) =>
    intendPayment(tx, {
      authorizationId,
      openJti: testId(),
      closedJti,
      requestHash: HASH,
      amountMinor: AMOUNT,
      currency: INR,
      outboxId,
    }),
  );

  return { ...intended, closedJti, authorizationId, outboxId };
}

const paymentOf = async (receipt: string) => {
  const rows = await sql<
    { order_id: string | null; state: string; in_doubt: boolean; in_doubt_reason: string | null }[]
  >`
    SELECT order_id, state, in_doubt, in_doubt_reason FROM payments WHERE receipt = ${receipt}
  `;
  return rows[0];
};

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
  await ensureAccounts(sql, INR);
});

describe("intending a payment", () => {
  it("derives the receipt and queues the Razorpay call in one transaction", async () => {
    const closedJti = testId();
    const { receipt } = await intend({ closedJti });

    expect(receipt).toBe(deriveReceipt(closedJti, HASH));

    const queued = await ofStream(sql, receipt);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "create_order", state: "pending" });
  });

  it("rolls the outbox back when the payment row cannot be written", async () => {
    const closedJti = testId();
    await intend({ closedJti });

    await expect(intend({ closedJti })).rejects.toThrow();

    const receipts = await sql`SELECT receipt FROM payments`;
    const messages = await sql`SELECT id FROM outbox`;
    expect(receipts).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });
});

describe("the outbox worker", () => {
  it("creates the order and records Razorpay's id", async () => {
    const razorpay = fakeRazorpay();
    const { receipt } = await intend();

    const result = await drainOne(sql, razorpay);

    expect(result).toMatchObject({ outcome: "done", kind: "create_order" });
    expect((await paymentOf(receipt))?.order_id).toMatch(/^order_fake_/);
    expect(razorpay.orders.size).toBe(1);
  });

  it("treats a timeout as in_doubt, never as failed", async () => {
    // The load-bearing distinction. Marking this failed and retrying with a
    // fresh receipt is how one purchase becomes two.
    const razorpay = fakeRazorpay();
    razorpay.timeoutNextCreate(false);
    const { receipt } = await intend();

    const result = await drainOne(sql, razorpay);

    expect(result?.outcome).toBe("in_doubt");
    expect(result?.detail).toContain("timed out");

    const payment = await paymentOf(receipt);
    expect(payment?.in_doubt).toBe(true);
    expect(payment?.order_id).toBeNull();
    expect(payment?.state).toBe("created");
  });

  it("recovers a create that timed out after landing", async () => {
    // The timeout lied: the order exists. Asking Razorpay about OUR receipt
    // finds it; retrying with a new receipt would have created a second one.
    const razorpay = fakeRazorpay();
    razorpay.timeoutNextCreate(true);
    const { receipt } = await intend();

    expect((await drainOne(sql, razorpay))?.outcome).toBe("in_doubt");
    expect(razorpay.orders.size).toBe(1);

    // The timeout queued a resolve_in_doubt. Drain that.
    const resolved = await drainOne(sql, razorpay);
    expect(resolved).toMatchObject({ outcome: "done", kind: "resolve_in_doubt" });

    const payment = await paymentOf(receipt);
    expect(payment?.in_doubt).toBe(false);
    expect(payment?.order_id).toMatch(/^order_fake_/);
  });

  it("recovers a duplicate receipt as success", async () => {
    const razorpay = fakeRazorpay();
    const { receipt, closedJti } = await intend();
    await drainOne(sql, razorpay);

    // A second intend for a different closed mandate cannot share a receipt;
    // force the same receipt onto a new outbox row to simulate a replay of
    // the original create after we already have the order.
    await sql`
      INSERT INTO outbox (id, kind, stream, payload)
      VALUES (
        ${testId()}, 'create_order', ${receipt},
        ${sql.json({ receipt, amount_minor: Number(AMOUNT), currency: "INR" })}
      )
    `;

    const replay = await drainOne(sql, razorpay);
    expect(replay?.outcome).toBe("done");
    expect(replay?.detail).toContain("recovered");
    expect(razorpay.orders.size).toBe(1);
    expect(closedJti).toBeTruthy();
  });

  it("does not let a capture overtake its create", async () => {
    const razorpay = fakeRazorpay();
    const { receipt } = await intend();

    await sql`
      INSERT INTO outbox (id, kind, stream, payload)
      VALUES (
        ${testId()}, 'capture_payment', ${receipt},
        ${sql.json({ receipt, payment_id: "pay_too_soon", amount_minor: Number(AMOUNT), currency: "INR" })}
      )
    `;

    // First drain takes the create (older). The capture waits because the
    // stream is in flight... except drainOne completes the create before
    // returning, so a second drainOne is what we actually assert: create
    // ran first.
    const first = await drainOne(sql, razorpay);
    expect(first?.kind).toBe("create_order");

    const second = await drainOne(sql, razorpay);
    expect(second?.kind).toBe("capture_payment");
  });

  it("gives a 4xx to failed rather than retrying it forever", async () => {
    const razorpay = fakeRazorpay();
    razorpay.failNextCreate(400, "amount must be at least 100");
    await intend();

    expect(await drainOne(sql, razorpay)).toMatchObject({ outcome: "failed" });
    expect(await drainOne(sql, razorpay)).toBeUndefined();
  });

  it("drains the queue", async () => {
    const razorpay = fakeRazorpay();
    await intend();
    await intend();

    const results = await drain(sql, razorpay);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === "done")).toBe(true);
    expect(await drainOne(sql, razorpay)).toBeUndefined();
  });
});

describe("reconciliation", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const window = () => ({ from: now() - 3_600, to: now() + 3_600 });

  it("is quiet when both sides agree", async () => {
    const razorpay = fakeRazorpay();
    await intend();
    await drainOne(sql, razorpay);

    const report = await reconcile(sql, razorpay, window());
    expect(report.exceptions).toEqual([]);
    expect(report.matched).toBe(1);
  });

  it("flags a local payment Razorpay has never seen", async () => {
    await intend();

    const report = await reconcile(sql, razorpayEmpty(), window());
    expect(report.exceptions.map((e) => e.kind)).toEqual(["MISSING_AT_PSP"]);
  });

  it("flags a Razorpay order we have no record of", async () => {
    const razorpay = fakeRazorpay();
    await razorpay.createOrder({
      amountMinor: AMOUNT,
      currency: "INR",
      receipt: deriveReceipt(testId(), HASH),
    });

    const report = await reconcile(sql, razorpay, window());
    expect(report.exceptions.map((e) => e.kind)).toEqual(["MISSING_LOCALLY"]);
  });

  it("flags an amount that does not match", async () => {
    const razorpay = fakeRazorpay();
    const { receipt } = await intend();
    await drainOne(sql, razorpay);

    const order = [...razorpay.orders.values()][0];
    if (order === undefined) throw new Error("expected an order");
    razorpay.orders.set(order.id, { ...order, amountMinor: 99n });

    const report = await reconcile(sql, razorpay, window());
    const mismatch = report.exceptions.find((e) => e.kind === "AMOUNT_MISMATCH");
    expect(mismatch?.receipt).toBe(receipt);
    expect(mismatch?.detail).toContain("99");
  });

  it("classifies a timeout as IN_DOUBT_UNRESOLVED, not as a failure", async () => {
    const razorpay = fakeRazorpay();
    razorpay.timeoutNextCreate(false);
    await intend();
    await drainOne(sql, razorpay);

    const report = await reconcile(sql, razorpay, window());
    expect(report.exceptions.map((e) => e.kind)).toEqual(["IN_DOUBT_UNRESOLVED"]);
  });

  it("adopts Razorpay's state when we lagged, without rewriting history", async () => {
    const razorpay = fakeRazorpay();
    const { receipt, authorizationId } = await intend();
    await drainOne(sql, razorpay);

    const order = [...razorpay.orders.values()][0];
    if (order === undefined) throw new Error("expected an order");
    seedPayment(razorpay, order.id, { status: "captured" });

    const before = await reconcile(sql, razorpay, window());
    expect(before.exceptions.map((e) => e.kind)).toEqual(["STATE_MISMATCH"]);

    expect(await adoptRemoteState(sql, razorpay, before)).toBe(1);
    expect((await paymentOf(receipt))?.state).toBe("captured");

    // The capture is a new ledger transaction, not an UPDATE of the hold.
    expect(await balanceOf(sql, "revenue:sales", INR)).toEqual(money(-AMOUNT, INR));
    const posted =
      await sql`SELECT id FROM ledger_transactions WHERE id = ${`${authorizationId}:capture`}`;
    expect(posted).toHaveLength(1);

    expect((await reconcile(sql, razorpay, window())).exceptions).toEqual([]);
  });
});

describe("receipts stay bound to the request", () => {
  it("changes when the request hash changes", () => {
    const jti = testId();
    expect(deriveReceipt(jti, HASH)).not.toBe(deriveReceipt(jti, digestJson({ amount: 1 })));
  });
});

function razorpayEmpty() {
  return fakeRazorpay();
}

// Keep the timeout type imported so a refactor that swallows it fails this file.
void RazorpayTimeout;
