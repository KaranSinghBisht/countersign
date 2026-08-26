import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { utf8 } from "../../src/crypto/encoding.js";
import type { Sql } from "../../src/db/client.js";
import { ensureAccounts } from "../../src/ledger/ledger.js";
import { deriveReceipt } from "../../src/razorpay/receipt.js";
import { signAsRazorpay } from "../../src/razorpay/signature.js";
import { ingest, processPending, STALENESS_WINDOW_SECONDS } from "../../src/razorpay/webhook.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;

const SECRET = "whsec_test_placeholder";
const NOW = 1_755_700_500;
const PAYMENT_ID = "pay_MgXyZ2def";
const ORDER_ID = "order_MgXyZ1abc";

function envelope(event: string, overrides: Record<string, unknown> = {}): Uint8Array {
  return utf8(
    JSON.stringify({
      event,
      created_at: NOW - 10,
      payload: {
        payment: {
          entity: { id: PAYMENT_ID, order_id: ORDER_ID, status: "captured", amount: 10_000 },
        },
      },
      ...overrides,
    }),
  );
}

async function deliver(body: Uint8Array, eventId: string, now = NOW) {
  return ingest(sql, {
    rawBody: body,
    signature: signAsRazorpay(body, SECRET),
    eventId,
    secret: SECRET,
    now,
  });
}

/** A local payment for the webhook to act on. */
async function seedPayment(state = "created") {
  const closedJti = testId();
  await sql`
    INSERT INTO payments (receipt, authorization_id, open_jti, closed_jti, order_id, payment_id, amount_minor, currency, state)
    VALUES (
      ${deriveReceipt(closedJti, "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8")},
      ${testId()}, ${testId()}, ${closedJti},
      ${ORDER_ID}, ${PAYMENT_ID}, 10000, 'INR', ${state}
    )
  `;
}

const stateOf = async () => {
  const rows = await sql<{ state: string }[]>`
    SELECT state FROM payments WHERE payment_id = ${PAYMENT_ID}
  `;
  return rows[0]?.state;
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
  await ensureAccounts(sql, "INR");
});

describe("accepting events", () => {
  it("accepts a correctly signed event", async () => {
    const result = await deliver(envelope("payment.captured"), "evt_1");

    expect(result).toMatchObject({ status: 200, outcome: "accepted" });
  });

  it("rejects a bad signature without touching the database", async () => {
    const body = envelope("payment.captured");

    const result = await ingest(sql, {
      rawBody: body,
      signature: signAsRazorpay(body, "the-wrong-secret"),
      eventId: "evt_1",
      secret: SECRET,
      now: NOW,
    });

    expect(result).toEqual({ status: 401, outcome: "bad_signature" });
    expect(await sql`SELECT 1 FROM webhook_events`).toHaveLength(0);
  });

  it("rejects a missing signature", async () => {
    const result = await ingest(sql, {
      rawBody: envelope("payment.captured"),
      signature: undefined,
      eventId: "evt_1",
      secret: SECRET,
      now: NOW,
    });

    expect(result).toEqual({ status: 401, outcome: "bad_signature" });
  });

  it("rejects a body that was modified after signing", async () => {
    const body = envelope("payment.captured");
    const signature = signAsRazorpay(body, SECRET);
    const tampered = utf8(new TextDecoder().decode(body).replace("10000", "1"));

    const result = await ingest(sql, {
      rawBody: tampered,
      signature,
      eventId: "evt_1",
      secret: SECRET,
      now: NOW,
    });

    expect(result).toEqual({ status: 401, outcome: "bad_signature" });
  });

  it("stores the raw body exactly as delivered", async () => {
    // A reserialised copy could never be re-verified, so the bytes have to
    // survive intact for anyone auditing the event later.
    const body = envelope("payment.captured");
    await deliver(body, "evt_1");

    const rows = await sql<{ raw_body: Buffer }[]>`
      SELECT raw_body FROM webhook_events WHERE event_id = 'evt_1'
    `;

    expect(new Uint8Array(rows[0]?.raw_body as Buffer)).toEqual(body);
  });

  it("requires an event id", async () => {
    const body = envelope("payment.captured");

    const result = await ingest(sql, {
      rawBody: body,
      signature: signAsRazorpay(body, SECRET),
      eventId: undefined,
      secret: SECRET,
      now: NOW,
    });

    expect(result).toMatchObject({ status: 400, outcome: "malformed" });
  });

  it("rejects an unparseable body", async () => {
    const body = utf8("not json at all");

    const result = await ingest(sql, {
      rawBody: body,
      signature: signAsRazorpay(body, SECRET),
      eventId: "evt_1",
      secret: SECRET,
      now: NOW,
    });

    expect(result).toMatchObject({ status: 400, outcome: "malformed" });
  });
});

describe("deduplication", () => {
  it("treats a redelivery as a duplicate", async () => {
    await deliver(envelope("payment.captured"), "evt_1");

    expect(await deliver(envelope("payment.captured"), "evt_1")).toMatchObject({
      outcome: "duplicate",
      status: 200,
    });

    expect(await sql`SELECT 1 FROM webhook_events`).toHaveLength(1);
  });

  it("acknowledges a duplicate with 200, not an error", async () => {
    // Anything other than a 2xx is a failure as far as Razorpay is concerned,
    // and a day of failures auto-disables the webhook.
    await deliver(envelope("payment.captured"), "evt_1");

    expect((await deliver(envelope("payment.captured"), "evt_1")).status).toBe(200);
  });

  it("treats the same signed body under a fresh event id as a duplicate", async () => {
    // The event-id header rides OUTSIDE the signature. If it were the only
    // dedupe key, one captured body could be replayed forever with fresh
    // ids, each copy passing verification and landing as a new row.
    const body = envelope("payment.captured");
    await deliver(body, "evt_original");

    expect(await deliver(body, "evt_replayed")).toMatchObject({
      outcome: "duplicate",
      status: 200,
    });

    expect(await sql`SELECT 1 FROM webhook_events`).toHaveLength(1);
  });

  it("admits exactly one of many concurrent redeliveries", async () => {
    // The reason dedupe is an INSERT rather than a SELECT then an INSERT.
    const body = envelope("payment.captured");

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ingest(sql, {
          rawBody: body,
          signature: signAsRazorpay(body, SECRET),
          eventId: "evt_race",
          secret: SECRET,
          now: NOW,
        }),
      ),
    );

    expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(9);
  });
});

describe("staleness", () => {
  it("accepts a retry from many hours ago", async () => {
    // Razorpay retries for about a day. A 5-minute tolerance copied from
    // Stripe would reject this legitimate retry.
    const body = envelope("payment.captured", { created_at: NOW - 20 * 60 * 60 });

    expect(await deliver(body, "evt_1")).toMatchObject({ outcome: "accepted" });
  });

  it("rejects an event older than the window", async () => {
    const body = envelope("payment.captured", {
      created_at: NOW - STALENESS_WINDOW_SECONDS - 60,
    });

    expect(await deliver(body, "evt_1")).toMatchObject({ outcome: "stale" });
  });

  it("tolerates mild clock skew but rejects the implausible future", async () => {
    expect(
      await deliver(envelope("payment.captured", { created_at: NOW + 60 }), "evt_1"),
    ).toMatchObject({ outcome: "accepted" });

    expect(
      await deliver(envelope("payment.captured", { created_at: NOW + 86_400 }), "evt_2"),
    ).toMatchObject({ outcome: "stale" });
  });

  it("honours an operator-supplied staleness window", async () => {
    const body = envelope("payment.captured", { created_at: NOW - 120 });
    const result = await ingest(sql, {
      rawBody: body,
      signature: signAsRazorpay(body, SECRET),
      eventId: "evt_short",
      secret: SECRET,
      now: NOW,
      maxAgeSeconds: 60,
    });
    expect(result).toMatchObject({ outcome: "stale" });
  });

  it("accepts an event with no timestamp", async () => {
    const body = utf8(
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: PAYMENT_ID } } },
      }),
    );

    expect(await deliver(body, "evt_1")).toMatchObject({ outcome: "accepted" });
  });
});

describe("applying events", () => {
  it("advances the payment state", async () => {
    await seedPayment("created");
    await deliver(envelope("payment.captured"), "evt_1");

    const [processed] = await processPending(sql);

    expect(processed).toMatchObject({ applied: true });
    expect(await stateOf()).toBe("captured");
  });

  it("applies order.paid via the order id when the event has no payment entity", async () => {
    await seedPayment("authorized");
    const body = utf8(
      JSON.stringify({
        event: "order.paid",
        created_at: NOW - 10,
        payload: { order: { entity: { id: ORDER_ID, status: "paid" } } },
      }),
    );
    await deliver(body, "evt_paid");

    const [processed] = await processPending(sql);
    expect(processed).toMatchObject({ applied: true });
    expect(await stateOf()).toBe("captured");
  });

  it("never regresses a captured payment", async () => {
    // Razorpay does not guarantee authorized arrives before captured.
    await seedPayment("captured");
    await deliver(envelope("payment.authorized"), "evt_late");

    const [processed] = await processPending(sql);

    expect(processed?.applied).toBe(false);
    expect(processed?.outcome).toContain("unordered");
    expect(await stateOf()).toBe("captured");
  });

  it("records an event it declines to apply", async () => {
    // "We saw this and chose not to regress" is the answer reconciliation
    // needs; silently dropping it leaves an unexplained gap.
    await seedPayment("captured");
    await deliver(envelope("payment.authorized"), "evt_late");
    await processPending(sql);

    const rows = await sql<{ applied: boolean; outcome: string; processed_at: Date }[]>`
      SELECT applied, outcome, processed_at FROM webhook_events WHERE event_id = 'evt_late'
    `;

    expect(rows[0]?.applied).toBe(false);
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]?.outcome).toBeTruthy();
  });

  it("reaches the same state whichever order events arrive in", async () => {
    await seedPayment("created");

    await deliver(envelope("payment.captured"), "evt_captured");
    await deliver(envelope("payment.authorized"), "evt_authorized");
    await processPending(sql);

    expect(await stateOf()).toBe("captured");
  });

  it("clears in_doubt once Razorpay tells us what happened", async () => {
    // The whole point of in_doubt: it is a question, and an authoritative
    // answer resolves it.
    await seedPayment("created");
    await sql`
      UPDATE payments
         SET in_doubt = TRUE, in_doubt_reason = 'timeout on orders.create'
       WHERE payment_id = ${PAYMENT_ID}
    `;

    await deliver(envelope("payment.captured"), "evt_1");
    await processPending(sql);

    const rows = await sql<{ in_doubt: boolean }[]>`
      SELECT in_doubt FROM payments WHERE payment_id = ${PAYMENT_ID}
    `;
    expect(rows[0]?.in_doubt).toBe(false);
  });

  it("does not invent a payment it has never seen", async () => {
    // Razorpay knowing about a payment we do not is a reconciliation finding,
    // not something this path should paper over.
    await deliver(envelope("payment.captured"), "evt_1");

    const [processed] = await processPending(sql);

    expect(processed?.applied).toBe(false);
    expect(processed?.outcome).toContain("no local payment");
  });

  it("does not poison an event that arrived before we stored the order id", async () => {
    await sql`
      INSERT INTO payments (receipt, authorization_id, open_jti, closed_jti, amount_minor, currency, state)
      VALUES (
        ${deriveReceipt(testId(), "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8")},
        ${testId()}, ${testId()}, ${testId()},
        10000, 'INR', 'created'
      )
    `;
    await deliver(envelope("payment.captured"), "evt_race");

    const [first] = await processPending(sql);
    expect(first?.applied).toBe(false);
    expect(first?.outcome).toMatch(/waiting for order_id/);

    const pending = await sql<{ processed_at: Date | null }[]>`
      SELECT processed_at FROM webhook_events WHERE event_id = 'evt_race'
    `;
    expect(pending[0]?.processed_at).toBeNull();

    await sql`UPDATE payments SET order_id = ${ORDER_ID} WHERE order_id IS NULL`;

    const [second] = await processPending(sql);
    expect(second?.applied).toBe(true);
    expect(await stateOf()).toBe("captured");
  });

  it("marks an unmodelled event processed rather than retrying it forever", async () => {
    await deliver(envelope("subscription.charged"), "evt_1");

    const [processed] = await processPending(sql);

    expect(processed?.applied).toBe(false);
    expect(processed?.outcome).toContain("unhandled");
    expect(await processPending(sql)).toHaveLength(0);
  });

  it("processes each event exactly once", async () => {
    await seedPayment("created");
    await deliver(envelope("payment.captured"), "evt_1");

    expect(await processPending(sql)).toHaveLength(1);
    expect(await processPending(sql)).toHaveLength(0);
  });

  it("keeps going when one event cannot be applied", async () => {
    await seedPayment("created");

    await deliver(envelope("payment.captured"), "evt_ok");
    await deliver(
      utf8(JSON.stringify({ event: "payment.failed", created_at: NOW, payload: {} })),
      "evt_no_payment",
    );

    const processed = await processPending(sql);

    expect(processed).toHaveLength(2);
    expect(await stateOf()).toBe("captured");
  });
});
