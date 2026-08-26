/**
 * The whole thesis, end to end: real purchases through the HTTP surface,
 * a signed checkpoint, an export from the live database, and the SAME
 * offline verifier a third party would run — against out-of-band trust —
 * saying yes.
 *
 * Nothing in this test is hand-sealed. If this passes, the demo bundle is a
 * rehearsal of something the production path actually does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportLiveBundle } from "../../src/audit/export-live.js";
import { publishCheckpoint } from "../../src/audit/log.js";
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
import {
  CLOSED_MANDATE_TYP,
  CLOSED_MANDATE_VCT,
  OPEN_MANDATE_TYP,
  OPEN_MANDATE_VCT,
} from "../../src/mandate/types.js";
import { hashJws } from "../../src/mandate/verify.js";
import { cartAsCheckout } from "../../src/payments/purchase.js";
import { loadBundle } from "../../src/verify/bundle.js";
import { verifyBundle } from "../../src/verify/checks.js";
import type { Trust } from "../../src/verify/trust.js";
import { migrateOnce, testDb, truncateAll } from "./helpers.js";

let sql: Sql;
let app: FastifyInstance;
let issuer: KeyPair;
let issuerPublic: PublicKeyRef;
let agent: KeyPair;
let checkpointKey: KeyPair;

const SECRET = "whsec_test_placeholder";
const ORIGIN = "countersign.dev/audit";
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

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
  issuer = await generateKey("ES256");
  issuerPublic = await importPublicKey(issuer.publicJwk);
  agent = await generateKey("ES256");
  checkpointKey = await generateKey("Ed25519");
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

async function buy(
  idempotencyKey: string,
  cart: typeof CART = CART,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const issued = await app.inject({
    method: "POST",
    url: "/nonce",
    headers: { "content-type": "application/json" },
    payload: { issued_to: "usr_8f3ac21e" },
  });
  const nonce = issued.json().nonce as string;
  const { openJws, closedJws } = await chainFor(nonce, cart);

  const response = await app.inject({
    method: "POST",
    url: "/purchase",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    payload: {
      actor_id: "usr_8f3ac21e",
      nonce,
      open_jws: openJws,
      closed_jws: closedJws,
      cart,
      proposal: {
        amount_paise: cart.total_paise,
        currency: cart.currency,
        payee: cart.payee,
        rail: cart.rail,
      },
    },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

describe("live export", () => {
  it("exports real purchases as a bundle the offline verifier accepts", async () => {
    const allowed = await buy("idem-export-allow");
    expect(allowed.statusCode).toBe(200);

    // Above spend.amount_range max — a refusal that must ALSO export cleanly.
    const denied = await buy("idem-export-deny", { ...CART, total_paise: 6_000_000 });
    expect(denied.statusCode).toBe(403);

    // Seal the log the way the worker does in production.
    await publishCheckpoint(sql, ORIGIN, ORIGIN, checkpointKey);

    const scratch = mkdtempSync(join(tmpdir(), "countersign-live-"));
    try {
      const exported = await exportLiveBundle(sql, join(scratch, "bundle"));
      expect(exported.records).toBe(2);
      expect(exported.treeSize).toBe(2);

      // Verify OFFLINE, with keys supplied out of band — never from the bundle.
      const trust: Trust = {
        origin: ORIGIN,
        audience: AUDIENCE,
        checkpointKeyName: ORIGIN,
        issuer: issuerPublic,
        checkpoint: await importPublicKey(checkpointKey.publicJwk, "Ed25519"),
      };
      const report = await verifyBundle(loadBundle(join(scratch, "bundle")), trust);

      const failures = report.checks
        .filter((c) => !c.ok)
        .map((c) => ({ id: c.spec.id, findings: c.findings }));
      expect(failures).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.passed).toBe(30);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses to export past the sealed prefix", async () => {
    const allowed = await buy("idem-export-unsealed");
    expect(allowed.statusCode).toBe(200);

    const scratch = mkdtempSync(join(tmpdir(), "countersign-unsealed-"));
    try {
      await expect(exportLiveBundle(sql, join(scratch, "bundle"))).rejects.toThrow(
        /no checkpoint published/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
