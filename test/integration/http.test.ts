import { createHash } from "node:crypto";
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

describe("discovery documents", () => {
  it("serves the landing page for humans at /", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("COUNTERSIGN");
    expect(response.body).toContain("/agents.md");
  });

  it("pins the landing page's one inline script by CSP hash, not 'unsafe-inline'", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    const csp = String(response.headers["content-security-policy"]);
    // The hash in the header must cover the exact bytes between the script
    // tags — recompute it from the served page, so whitespace drift fails here
    // instead of silently disabling the script in every browser.
    const script = /<script>([\s\S]*?)<\/script>/.exec(response.body)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(0);
    const digest = createHash("sha256").update(script, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'sha256-${digest}'`);
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("serves the buyer-agent contract at /agents.md", async () => {
    const response = await app.inject({ method: "GET", url: "/agents.md" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.body).toContain("POST /nonce");
    expect(response.body).toContain("Idempotency-Key");
    // The honesty clause travels with the contract, not just the README.
    expect(response.body).toContain("Not built, said plainly");
  });

  it("serves the crawler pointer at /llms.txt", async () => {
    const response = await app.inject({ method: "GET", url: "/llms.txt" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("/agents.md");
  });

  it("answers unknown routes in the contract's envelope, not Fastify's", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ outcome: "rejected", at: "schema", detail: "no such route" });
  });

  it("serves the system diagram at /architecture", async () => {
    const page = await app.inject({ method: "GET", url: "/architecture" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("/assets/architecture.png");

    const image = await app.inject({ method: "GET", url: "/assets/architecture.png" });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
  });
});

describe("hero media", () => {
  it("serves the hero loop with single-range support", async () => {
    const full = await app.inject({ method: "GET", url: "/hero-video.mp4" });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toContain("video/mp4");
    expect(full.headers["accept-ranges"]).toBe("bytes");

    // Safari will not play media unless ranged reads actually work.
    const part = await app.inject({
      method: "GET",
      url: "/hero-video.mp4",
      headers: { range: "bytes=0-99" },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect(part.rawPayload.byteLength).toBe(100);

    const unsatisfiable = await app.inject({
      method: "GET",
      url: "/hero-video.mp4",
      headers: { range: "bytes=999999999-" },
    });
    expect(unsatisfiable.statusCode).toBe(416);
  });

  it("serves the reduced-motion poster", async () => {
    const poster = await app.inject({ method: "GET", url: "/hero-poster.jpg" });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toContain("image/jpeg");
  });

  it("serves pixel-art accents from the boot-time allowlist only", async () => {
    const png = await app.inject({ method: "GET", url: "/assets/ledger.png" });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toContain("image/png");

    const svg = await app.inject({ method: "GET", url: "/assets/verified-stamp.svg" });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toContain("image/svg");

    // A name outside the allowlist is a 404 — never a path lookup.
    expect((await app.inject({ method: "GET", url: "/assets/..%2F..%2F.env" })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: "GET", url: "/assets/nope.png" })).statusCode).toBe(404);
  });
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
  async function seedRecord(orderId: string | null) {
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

  it("proves inclusion against the signed checkpoint, never the unsigned tip", async () => {
    await seedRecord("order_proof");

    // Appended but not yet sealed: there is nothing signed to prove against.
    expect((await app.inject({ method: "GET", url: "/audit/proof?seq=0" })).statusCode).toBe(404);

    const key = await generateKey("Ed25519");
    const { note } = await publishCheckpoint(
      sql,
      "countersign.dev/audit",
      "countersign.dev/audit",
      key,
    );

    const ok = await app.inject({ method: "GET", url: "/audit/proof?seq=0" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ seq: 0, tree_size: 1, checkpoint_note: note });
    expect(ok.json().proof).toEqual([]);

    const consistency = await app.inject({ method: "GET", url: "/audit/consistency?from=0" });
    expect(consistency.statusCode).toBe(200);
    expect(consistency.json()).toMatchObject({ from: 0, to: 1, proof: [] });

    expect((await app.inject({ method: "GET", url: "/audit/proof?seq=4" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/audit/proof" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/audit/proof?seq=0x10" })).statusCode).toBe(
      400,
    );
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

  it("resolves an order through its payment, since a live record never carries one", async () => {
    // Appended at intent time with order_id null — exactly what /purchase writes.
    const record = await seedRecord(null);
    await sql`
      INSERT INTO payments (receipt, authorization_id, open_jti, closed_jti, order_id, amount_minor, currency, state)
      VALUES ('rcpt_live', ${testId()}, ${record.mandate.open_jti}, ${record.mandate.closed_jti},
              'order_live', 1000, 'INR', 'created')
    `;

    const found = await app.inject({ method: "GET", url: "/audit/orders/order_live" });
    expect(found.statusCode).toBe(200);
    expect(found.json().records).toHaveLength(1);
    expect(found.json().records[0].mandate.closed_jti).toBe(record.mandate.closed_jti);
  });
});
