/**
 * The payer page and Checkout's callback: the human side of the money loop.
 *
 * A callback is believed only when Razorpay's payment signature verifies with
 * the key secret; a verified one records the payment and queues exactly one
 * capture, however many times it, or the webhook, says so.
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../../src/db/client.js";
import { buildApp } from "../../src/http/app.js";
import { deriveReceipt } from "../../src/razorpay/receipt.js";
import { signAsRazorpay } from "../../src/razorpay/signature.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;
let app: FastifyInstance;

const KEY_ID = "rzp_test_paypage";
const KEY_SECRET = "key_secret_test_placeholder";
const ORDER_ID = "order_PayPage1";
const PAYMENT_ID = "pay_PayPage1";

async function seedPayment(orderId: string | null): Promise<string> {
  const receipt = deriveReceipt(testId(), "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8");
  await sql`
    INSERT INTO payments (receipt, authorization_id, open_jti, closed_jti, order_id, amount_minor, currency, state)
    VALUES (${receipt}, ${testId()}, ${testId()}, ${testId()}, ${orderId}, 1499000, 'INR', 'created')
  `;
  return receipt;
}

function callback(orderId: string, paymentId: string, secret = KEY_SECRET) {
  return {
    razorpay_payment_id: paymentId,
    razorpay_order_id: orderId,
    razorpay_signature: signAsRazorpay(`${orderId}|${paymentId}`, secret),
  };
}

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
  app = await buildApp({
    sql,
    config: {
      RAZORPAY_WEBHOOK_SECRET: "whsec_test_placeholder",
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_MODE: "live",
    },
  });
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
});

describe("GET /pay", () => {
  it("renders Checkout for an order we hold, with its own CSP", async () => {
    const receipt = await seedPayment(ORDER_ID);
    const page = await app.inject({ method: "GET", url: `/pay/${ORDER_ID}` });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["content-security-policy"]).toContain("https://checkout.razorpay.com");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("checkout.razorpay.com/v1/checkout.js");
    expect(page.body).toContain(KEY_ID);
    expect(page.body).toContain(ORDER_ID);
    expect(page.body).toContain(receipt);
    expect(page.body).toContain("₹14,990.00");
    // The key SECRET never reaches the browser.
    expect(page.body).not.toContain(KEY_SECRET);
  });

  it("finds the page by receipt once the worker has created the order", async () => {
    const receipt = await seedPayment(null);
    expect((await app.inject({ method: "GET", url: `/pay/r/${receipt}` })).statusCode).toBe(202);

    await sql`UPDATE payments SET order_id = ${ORDER_ID} WHERE receipt = ${receipt}`;
    const found = await app.inject({ method: "GET", url: `/pay/r/${receipt}` });
    expect(found.statusCode).toBe(302);
    expect(found.headers.location).toBe(`/pay/${ORDER_ID}`);

    expect((await app.inject({ method: "GET", url: "/pay/r/nope" })).statusCode).toBe(404);
  });

  it("refuses what it does not hold or cannot parse", async () => {
    expect((await app.inject({ method: "GET", url: "/pay/order_unknown" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/pay/not-an-order" })).statusCode).toBe(400);
  });

  it("is unavailable without a live rail", async () => {
    const offline = await buildApp({
      sql,
      config: { RAZORPAY_WEBHOOK_SECRET: "whsec_test_placeholder", RAZORPAY_MODE: "fake" },
    });
    await seedPayment(ORDER_ID);
    expect((await offline.inject({ method: "GET", url: `/pay/${ORDER_ID}` })).statusCode).toBe(503);
    await offline.close();
  });
});

describe("POST /pay/:order_id/complete", () => {
  it("records a verified payment and queues exactly one capture", async () => {
    const receipt = await seedPayment(ORDER_ID);

    const first = await app.inject({
      method: "POST",
      url: `/pay/${ORDER_ID}/complete`,
      headers: { "content-type": "application/json" },
      payload: callback(ORDER_ID, PAYMENT_ID),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      outcome: "paid",
      payment_id: PAYMENT_ID,
      signature_verified: true,
      capture: "queued",
    });

    const [payment] = await sql<{ payment_id: string | null; signature_verified: boolean }[]>`
      SELECT payment_id, signature_verified FROM payments WHERE receipt = ${receipt}
    `;
    expect(payment).toEqual({ payment_id: PAYMENT_ID, signature_verified: true });

    const queued = await sql<{ id: string; kind: string; stream: string; state: string }[]>`
      SELECT id, kind, stream, state FROM outbox
    `;
    expect(queued).toEqual([
      { id: `capture:${PAYMENT_ID}`, kind: "capture_payment", stream: receipt, state: "pending" },
    ]);

    // The browser retried, or the webhook said the same thing: still one capture.
    const again = await app.inject({
      method: "POST",
      url: `/pay/${ORDER_ID}/complete`,
      headers: { "content-type": "application/json" },
      payload: callback(ORDER_ID, PAYMENT_ID),
    });
    expect(again.json().capture).toBe("already_queued");
    expect(await sql`SELECT 1 FROM outbox`).toHaveLength(1);
  });

  it("does not believe a callback whose signature was not made with our key secret", async () => {
    const receipt = await seedPayment(ORDER_ID);

    const forged = await app.inject({
      method: "POST",
      url: `/pay/${ORDER_ID}/complete`,
      headers: { "content-type": "application/json" },
      payload: callback(ORDER_ID, PAYMENT_ID, "somebody-elses-secret"),
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ outcome: "rejected", at: "signature" });

    const [payment] = await sql<{ signature_verified: boolean }[]>`
      SELECT signature_verified FROM payments WHERE receipt = ${receipt}
    `;
    expect(payment?.signature_verified).toBe(false);
    expect(await sql`SELECT 1 FROM outbox`).toHaveLength(0);
  });

  it("refuses a callback for a different order than the URL names", async () => {
    await seedPayment(ORDER_ID);
    const crossed = await app.inject({
      method: "POST",
      url: `/pay/${ORDER_ID}/complete`,
      headers: { "content-type": "application/json" },
      payload: callback("order_Other1", PAYMENT_ID),
    });
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json()).toMatchObject({ outcome: "rejected", at: "schema" });
  });

  it("a bogus callback cannot touch a settled order's attested columns or 500", async () => {
    // order ids ride in the pay links, so /complete is a public write target.
    // An unauthenticated caller must not clobber the payment Razorpay attested
    // to, nor collide the payment_id UNIQUE index into an internal error.
    const receipt = await seedPayment(ORDER_ID);
    await sql`
      UPDATE payments
         SET state = 'captured', payment_id = ${PAYMENT_ID},
             signature = 'real_sig', signature_verified = TRUE
       WHERE receipt = ${receipt}
    `;

    // Forged signature over an attacker payment id: rejected, nothing written.
    const forged = await app.inject({
      method: "POST",
      url: `/pay/${ORDER_ID}/complete`,
      headers: { "content-type": "application/json" },
      payload: {
        razorpay_payment_id: "pay_attacker0001",
        razorpay_order_id: ORDER_ID,
        razorpay_signature: "0".repeat(64),
      },
    });
    expect(forged.statusCode).toBe(400);

    // A valid callback whose payment id already belongs to the settled order
    // would collide the UNIQUE index; it must be caught, not surface a 500.
    await sql`
      INSERT INTO payments (receipt, authorization_id, open_jti, closed_jti, order_id, amount_minor, currency, state)
      VALUES (${deriveReceipt(testId(), "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8")},
              ${testId()}, ${testId()}, ${testId()}, 'order_Second1', 1499000, 'INR', 'created')
    `;
    const collide = await app.inject({
      method: "POST",
      url: "/pay/order_Second1/complete",
      headers: { "content-type": "application/json" },
      payload: callback("order_Second1", PAYMENT_ID),
    });
    expect(collide.statusCode).not.toBe(500);

    // The originally settled row is untouched.
    const [settled] = await sql<
      { payment_id: string; signature: string; signature_verified: boolean }[]
    >`
      SELECT payment_id, signature, signature_verified FROM payments WHERE receipt = ${receipt}
    `;
    expect(settled).toEqual({
      payment_id: PAYMENT_ID,
      signature: "real_sig",
      signature_verified: true,
    });
  });
});
