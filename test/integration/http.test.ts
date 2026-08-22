import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { append, publishCheckpoint } from "../../src/audit/log.js";
import { GENESIS_HASH } from "../../src/audit/record.js";
import { utf8 } from "../../src/crypto/encoding.js";
import { generateKey } from "../../src/crypto/keys.js";
import type { Sql } from "../../src/db/client.js";
import { buildApp } from "../../src/http/app.js";
import { signAsRazorpay } from "../../src/razorpay/signature.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;
let app: FastifyInstance;

const SECRET = "whsec_test_placeholder";
const NOW = 1_755_700_500;
const DIGEST = "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8";

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
  app = await buildApp({
    sql,
    config: { RAZORPAY_WEBHOOK_SECRET: SECRET },
    now: () => NOW,
  });
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
});

describe("POST /webhooks/razorpay", () => {
  it("verifies the signature over the bytes as sent, not a reserialised body", async () => {
    // Compact-with-spaces is what a global JSON parser would "fix". The
    // signature is over these exact bytes; if the route parsed and
    // re-encoded, this would 401 and the cause would be nowhere near the
    // symptom.
    const body = '{"event": "payment.captured", "created_at": 1755700490, "payload": {}}';

    const accepted = await app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signAsRazorpay(utf8(body), SECRET),
        "x-razorpay-event-id": "evt_http_1",
      },
      payload: body,
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ outcome: "accepted" });

    const reserialised = JSON.stringify(JSON.parse(body));
    expect(reserialised).not.toBe(body);

    const rejected = await app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signAsRazorpay(utf8(body), SECRET),
        "x-razorpay-event-id": "evt_http_2",
      },
      payload: reserialised,
    });

    expect(rejected.statusCode).toBe(401);
  });

  it("acknowledges a duplicate with 200", async () => {
    const body = '{"event":"payment.captured","created_at":1755700490,"payload":{}}';
    const headers = {
      "content-type": "application/json",
      "x-razorpay-signature": signAsRazorpay(utf8(body), SECRET),
      "x-razorpay-event-id": "evt_dup",
    };

    expect(
      (await app.inject({ method: "POST", url: "/webhooks/razorpay", headers, payload: body }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ method: "POST", url: "/webhooks/razorpay", headers, payload: body })
      ).json(),
    ).toMatchObject({ outcome: "duplicate" });
  });
});

describe("GET /audit/*", () => {
  async function seedRecord(orderId: string) {
    return sql.begin((tx) =>
      append(tx, {
        ts: new Date(NOW * 1000).toISOString(),
        trace_id: testId(),
        actor: {
          principal_id: "usr_9f2",
          agent_id: "agent:pricing-bot",
          agent_version: "1.4.2",
          model: "claude-opus-5",
          runtime_sha256: DIGEST,
        },
        mandate: {
          open_jti: testId(),
          open_hash: DIGEST,
          closed_jti: testId(),
          closed_hash: DIGEST,
          chain_depth: 2,
        },
        intent: { prompt_sha256: DIGEST, prompt_bytes: 10, redaction_profile: "pii-v2" },
        tool: { name: "razorpay.orders.create", args: { amount: 1000 }, args_sha256: DIGEST },
        policy: {
          bundle_sha256: DIGEST,
          engine_version: "0.3.1",
          rules_evaluated: [{ id: "R-BUD-INR", constraint: "spend.budget", effect: "permit" }],
          first_deny: null,
        },
        accounting: {
          spent_before_paise: 0,
          amount_paise: 1000,
          spent_after_paise: 1000,
          actions_before: 0,
          actions_after: 1,
          budget_max_paise: 30_000,
          currency: "INR",
        },
        decision: "ALLOW",
        reason: "within budget",
        external: {
          rail: "razorpay",
          idempotency_key: "idem-1",
          order_id: orderId,
          payment_id: null,
          signature_verified: false,
          status: "created",
        },
        output_sha256: null,
      }),
    );
  }

  it("serves the latest checkpoint note verbatim", async () => {
    expect((await app.inject({ method: "GET", url: "/audit/checkpoint" })).statusCode).toBe(404);

    await seedRecord("order_audit");
    const key = await generateKey("Ed25519");
    const { note } = await publishCheckpoint(
      sql,
      "countersign.dev/audit",
      "countersign.dev/audit",
      key,
    );

    const response = await app.inject({ method: "GET", url: "/audit/checkpoint" });
    expect(response.statusCode).toBe(200);
    expect(response.json().note).toBe(note);
    expect(response.json().size).toBe(1);
  });

  it("serves an inclusion proof for a known seq", async () => {
    await seedRecord("order_proof");

    const ok = await app.inject({ method: "GET", url: "/audit/proof?seq=0" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ seq: 0, tree_size: 1 });
    expect(ok.json().proof).toEqual([]);

    expect((await app.inject({ method: "GET", url: "/audit/proof?seq=4" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/audit/proof" })).statusCode).toBe(400);
  });

  it("returns every record for an order", async () => {
    await seedRecord("order_abc");

    const found = await app.inject({ method: "GET", url: "/audit/orders/order_abc" });
    expect(found.statusCode).toBe(200);
    expect(found.json().records).toHaveLength(1);
    expect(found.json().records[0].prev_hash).toBe(GENESIS_HASH);

    expect(
      (await app.inject({ method: "GET", url: "/audit/orders/order_missing" })).statusCode,
    ).toBe(404);
  });
});
