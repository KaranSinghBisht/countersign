import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { latestCheckpoint, selfCheck } from "../../src/audit/log.js";
import type { AuditRecord } from "../../src/audit/record.js";
import type { JsonValue } from "../../src/crypto/canonical.js";
import { canonicalBytes } from "../../src/crypto/canonical.js";
import { digestB64u } from "../../src/crypto/digest.js";
import { sign } from "../../src/crypto/jws.js";
import {
  generateKey,
  importPublicKey,
  type KeyPair,
  type PublicKeyRef,
} from "../../src/crypto/keys.js";
import type { Sql } from "../../src/db/client.js";
import { buildApp } from "../../src/http/app.js";
import { startWorkers } from "../../src/http/worker.js";
import {
  CLOSED_MANDATE_TYP,
  CLOSED_MANDATE_VCT,
  OPEN_MANDATE_TYP,
  OPEN_MANDATE_VCT,
} from "../../src/mandate/types.js";
import { hashJws } from "../../src/mandate/verify.js";
import { cartAsCheckout } from "../../src/payments/purchase.js";
import { fakeRazorpay } from "../../src/razorpay/fake.js";
import type { Logger } from "../../src/telemetry/logger.js";
import { migrateOnce, testDb, truncateAll } from "./helpers.js";

let sql: Sql;
let app: FastifyInstance;
let issuer: KeyPair;
let issuerPublic: PublicKeyRef;
let agent: KeyPair;

const SECRET = "whsec_test_placeholder";
const AUDIENCE = "https://countersign.example/agent-commerce";
const NOW = 1_755_700_500;

const CART = {
  total_paise: 1_499_000,
  currency: "INR" as const,
  payee: { id: "vnd_1042" },
  rail: "razorpay_order",
};

const CONSTRAINTS = [
  { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 },
  { type: "spend.budget", currency: "INR", max: 25_000_000 },
  { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
  { type: "spend.rail", allowed: ["razorpay_order"] },
];

const PROPOSAL = {
  amount_paise: CART.total_paise,
  currency: CART.currency,
  payee: CART.payee,
  rail: CART.rail,
};

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
  issuer = await generateKey("ES256");
  issuerPublic = await importPublicKey(issuer.publicJwk);
  agent = await generateKey("ES256");
  app = await buildApp({
    sql,
    config: { RAZORPAY_WEBHOOK_SECRET: SECRET },
    now: () => NOW,
    issuer: issuerPublic,
    audience: AUDIENCE,
  });
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
});

async function chainFor(
  nonce: string,
  cart: typeof CART = CART,
): Promise<{ openJws: string; closedJws: string }> {
  const openJws = await sign(
    {
      vct: OPEN_MANDATE_VCT,
      iss: "https://countersign.example/consent",
      sub: "usr_8f3ac21e",
      aud: AUDIENCE,
      jti: ulid(),
      iat: 1_755_700_000,
      nbf: 1_755_700_000,
      exp: 1_755_786_400,
      cnf: {
        jwk: {
          kty: "EC",
          crv: "P-256",
          x: agent.publicJwk.x as string,
          y: agent.publicJwk.y as string,
          alg: "ES256",
          kid: agent.kid,
        },
      },
      purpose: "q3_inventory_restock",
      policy_bundle_sha256: digestB64u(canonicalBytes("policy")),
      constraints: CONSTRAINTS,
    } as JsonValue,
    issuer,
    OPEN_MANDATE_TYP,
  );

  const closedJws = await sign(
    {
      vct: CLOSED_MANDATE_VCT,
      iss: "agent:pricing-bot",
      sub: "usr_8f3ac21e",
      aud: AUDIENCE,
      jti: ulid(),
      iat: 1_755_700_480,
      exp: 1_755_700_600,
      parent_hash: hashJws(openJws),
      request_hash: digestB64u(canonicalBytes(cartAsCheckout(cart))),
      nonce,
      amount: { amount: cart.total_paise, currency: cart.currency },
      payee: cart.payee,
      agent: {
        id: "pricing-bot",
        version: "1.4.2",
        model: "claude-opus-5",
        runtime_sha256: digestB64u(canonicalBytes("runtime")),
      },
      chain_depth: 2,
    } as JsonValue,
    agent,
    CLOSED_MANDATE_TYP,
  );

  return { openJws, closedJws };
}

describe("POST /nonce and POST /purchase", () => {
  it("issues a nonce and permits a bound purchase", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/nonce",
      headers: { "content-type": "application/json" },
      payload: { issued_to: "usr_8f3ac21e" },
    });
    expect(issued.statusCode).toBe(200);
    const nonce = issued.json().nonce as string;

    const { openJws, closedJws } = await chainFor(nonce);
    const bought = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-purchase-1",
      },
      payload: {
        actor_id: "usr_8f3ac21e",
        nonce,
        open_jws: openJws,
        closed_jws: closedJws,
        cart: CART,
        proposal: PROPOSAL,
      },
    });

    expect(bought.statusCode).toBe(200);
    expect(bought.json()).toMatchObject({ outcome: "permitted" });

    const payments = await sql`SELECT receipt, state FROM payments`;
    expect(payments).toHaveLength(1);
    expect(payments[0]?.state).toBe("created");

    // The money action landed in the audit log, in the same transaction.
    const records = await sql<{ record: AuditRecord }[]>`
			SELECT record FROM audit_records ORDER BY seq
		`;
    expect(records).toHaveLength(1);
    const record = records[0]?.record as AuditRecord;
    expect(record.decision).toBe("ALLOW");
    expect(record.policy.first_deny).toBeNull();
    expect(record.tool.args.receipt).toBe(payments[0]?.receipt);
    expect(record.external?.status).toBe("intended");
    expect(record.accounting.amount_paise).toBe(CART.total_paise);
    expect(bought.json().audit).toMatchObject({ seq: 0, record_hash: record.record_hash });
    expect(await selfCheck(sql)).toEqual([]);

    const replay = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-purchase-1",
      },
      payload: {
        actor_id: "usr_8f3ac21e",
        nonce,
        open_jws: openJws,
        closed_jws: closedJws,
        cart: CART,
        proposal: PROPOSAL,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().authorization_id).toBe(bought.json().authorization_id);
  });

  it("refuses a purchase without an Idempotency-Key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: { "content-type": "application/json" },
      payload: { actor_id: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toMatch(/Idempotency-Key/);
  });

  it("refuses oversized keys and control characters at the boundary, never as a 500", async () => {
    const tooLong = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: { "content-type": "application/json", "idempotency-key": "k".repeat(201) },
      payload: { actor_id: "usr_8f3ac21e" },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ outcome: "rejected", at: "schema" });

    // A NUL byte used to reach Postgres and come back as an internal error.
    const nul = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: { "content-type": "application/json", "idempotency-key": "idem-nul-1" },
      payload: {
        actor_id: "usr\u0000evil",
        nonce: "n".repeat(32),
        open_jws: "a.b.c",
        closed_jws: "a.b.c",
        cart: CART,
        proposal: PROPOSAL,
      },
    });
    expect(nul.statusCode).toBe(400);
    expect(nul.json()).toMatchObject({ outcome: "rejected", at: "schema" });
    expect(await sql`SELECT 1 FROM idempotency_keys`).toHaveLength(0);
  });

  it("denies an out-of-range purchase and still writes the audit record", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/nonce",
      headers: { "content-type": "application/json" },
      payload: { issued_to: "usr_8f3ac21e" },
    });
    const nonce = issued.json().nonce as string;

    // Above the spend.amount_range max of 5_000_000 paise.
    const cart = { ...CART, total_paise: 6_000_000 };
    const { openJws, closedJws } = await chainFor(nonce, cart);

    const bought = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: { "content-type": "application/json", "idempotency-key": "idem-deny-1" },
      payload: {
        actor_id: "usr_8f3ac21e",
        nonce,
        open_jws: openJws,
        closed_jws: closedJws,
        cart,
        proposal: { ...PROPOSAL, amount_paise: cart.total_paise },
      },
    });

    expect(bought.statusCode).toBe(403);
    expect(bought.json()).toMatchObject({ outcome: "denied", decided_by: "R-AMT-INR" });

    // A refusal is a money action too: it lands in the log, and nothing
    // reaches the payments table or the outbox.
    const records = await sql<{ record: AuditRecord }[]>`
			SELECT record FROM audit_records ORDER BY seq
		`;
    expect(records).toHaveLength(1);
    const record = records[0]?.record as AuditRecord;
    expect(record.decision).toBe("DENY");
    expect(record.policy.first_deny).toBe("R-AMT-INR");
    expect(record.external).toBeNull();
    expect(bought.json().audit).toMatchObject({ seq: 0, record_hash: record.record_hash });

    expect(await sql`SELECT 1 FROM payments`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM outbox`).toHaveLength(0);
    expect(await selfCheck(sql)).toEqual([]);
  });

  it("answers malformed JSON with the caller's 400, not our 500", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/nonce",
      headers: { "content-type": "application/json" },
      payload: "this is not json",
    });
    expect(response.statusCode).toBe(400);
  });

  it("publishes a checkpoint once the log grows", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/nonce",
      headers: { "content-type": "application/json" },
      payload: { issued_to: "usr_8f3ac21e" },
    });
    const nonce = issued.json().nonce as string;
    const { openJws, closedJws } = await chainFor(nonce);

    const bought = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: { "content-type": "application/json", "idempotency-key": "idem-checkpoint-1" },
      payload: {
        actor_id: "usr_8f3ac21e",
        nonce,
        open_jws: openJws,
        closed_jws: closedJws,
        cart: CART,
        proposal: PROPOSAL,
      },
    });
    expect(bought.statusCode).toBe(200);

    const silent = {
      info: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    } as unknown as Logger;
    const checkpointKey = await generateKey("Ed25519");
    const stop = startWorkers(sql, fakeRazorpay(), silent, {
      intervalMs: 50,
      checkpoint: { origin: "countersign.dev/audit", key: checkpointKey },
    });

    try {
      const deadline = Date.now() + 5_000;
      let checkpoint = await latestCheckpoint(sql);
      while (checkpoint === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        checkpoint = await latestCheckpoint(sql);
      }
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.checkpoint.size).toBe(1);
      expect(checkpoint?.checkpoint.origin).toBe("countersign.dev/audit");
    } finally {
      stop();
    }
  });
});

describe("one-in-flight contention", () => {
  async function closedFor(openJws: string, nonce: string): Promise<string> {
    return sign(
      {
        vct: CLOSED_MANDATE_VCT,
        iss: "agent:pricing-bot",
        sub: "usr_8f3ac21e",
        aud: AUDIENCE,
        jti: ulid(),
        iat: 1_755_700_480,
        exp: 1_755_700_600,
        parent_hash: hashJws(openJws),
        request_hash: digestB64u(canonicalBytes(cartAsCheckout(CART))),
        nonce,
        amount: { amount: CART.total_paise, currency: CART.currency },
        payee: CART.payee,
        agent: {
          id: "pricing-bot",
          version: "1.4.2",
          model: "claude-opus-5",
          runtime_sha256: digestB64u(canonicalBytes("runtime")),
        },
        chain_depth: 2,
      } as JsonValue,
      agent,
      CLOSED_MANDATE_TYP,
    );
  }

  async function issueNonce(): Promise<string> {
    const issued = await app.inject({
      method: "POST",
      url: "/nonce",
      headers: { "content-type": "application/json" },
      payload: { issued_to: "usr_8f3ac21e" },
    });
    return issued.json().nonce as string;
  }

  it("rolls back on contention: the nonce survives and the key is released", async () => {
    const first = await issueNonce();
    const { openJws, closedJws } = await chainFor(first);
    const body = (nonce: string, closed: string) => ({
      actor_id: "usr_8f3ac21e",
      nonce,
      open_jws: openJws,
      closed_jws: closed,
      cart: CART,
      proposal: PROPOSAL,
    });
    const headers = (key: string) => ({
      "content-type": "application/json",
      "idempotency-key": key,
    });

    const bought = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: headers("idem-contend-1"),
      payload: body(first, closedJws),
    });
    expect(bought.statusCode).toBe(200);

    // A second buy under the same open mandate while the first is still
    // authorized: AP2's one-in-flight rule refuses it.
    const second = await issueNonce();
    const closed2 = await closedFor(openJws, second);
    const refused = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: headers("idem-contend-2"),
      payload: body(second, closed2),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ outcome: "already_in_flight" });
    expect(refused.headers["retry-after"]).toBeDefined();

    // Contention is not a verdict: the transaction rolled back, so the nonce
    // was not burned and the key was handed back. A retry under a fresh key
    // meets the same contention — not a nonce rejection, not a stored 409.
    const keys = await sql`SELECT idem_key FROM idempotency_keys WHERE idem_key = 'idem-contend-2'`;
    expect(keys).toHaveLength(0);

    const retried = await app.inject({
      method: "POST",
      url: "/purchase",
      headers: headers("idem-contend-3"),
      payload: body(second, closed2),
    });
    expect(retried.statusCode).toBe(409);
    expect(retried.json()).toMatchObject({ outcome: "already_in_flight" });
  });
});

describe("rate limiting", () => {
  it("answers the 121st request in a minute with 429 and Retry-After", async () => {
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 121; i += 1) {
      last = await app.inject({
        method: "POST",
        url: "/nonce",
        headers: { "content-type": "application/json" },
        payload: { issued_to: "usr_storm" },
      });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json()).toMatchObject({ outcome: "rate_limited" });
    expect(last?.headers["retry-after"]).toBeDefined();
  });
});
