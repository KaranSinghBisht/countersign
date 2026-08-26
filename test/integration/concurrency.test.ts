import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "../../src/db/client.js";
import { claim, complete, reapExpiredLeases } from "../../src/http/idempotency.js";
import { balanceOf, ensureAccounts } from "../../src/ledger/ledger.js";
import { type Constraint, ConstraintSchema } from "../../src/mandate/constraints.js";
import { money, zero } from "../../src/money/money.js";
import { attemptSpend, spendOf } from "../../src/spend/accounting.js";
import { consume, issue } from "../../src/spend/nonce.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;
const INR = "INR" as const;
const NOW = 1_755_700_500;
const amount = (minor: bigint) => money(minor, INR);

const parse = (input: unknown): Constraint => ConstraintSchema.parse(input);

/** ₹100 cap per transaction, ₹300 aggregate. Room for exactly three. */
const CONSTRAINTS = [
  { type: "spend.amount_range", currency: "INR", min: 0, max: 10_000 },
  { type: "spend.budget", currency: "INR", max: 30_000 },
  { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
  { type: "spend.rail", allowed: ["razorpay_order"] },
].map(parse);

const REQUEST = {
  amount: amount(10_000n),
  payee: { id: "vnd_1042" },
  rail: "razorpay_order",
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

describe("concurrent spend against a shared budget", () => {
  it("admits exactly three of twenty simultaneous requests", async () => {
    // The headline test. Twenty requests, a budget with room for three, all
    // launched before any of them commits. Reading the balance outside a lock
    // gives every request the same "before" and every request concludes there
    // is room — the classic version of this bug produces twenty successes and
    // a ₹2,000 overspend.
    //
    // Each request carries its own closed mandate, so the replay guard is not
    // what limits them. Only the row lock and the budget are.
    //
    // captureImmediately models a synchronous rail: nothing stays outstanding,
    // so AP2's one-in-flight rule does not bind and the budget is the sole
    // limiter. Without it this test measures one-in-flight instead — the
    // answer would be 1 permitted and 19 rejected, which is a different (and
    // separately tested) property.
    const openJti = testId();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        attemptSpend(sql, {
          openJti,
          closedJti: testId(),
          constraints: CONSTRAINTS,
          request: REQUEST,
          now: NOW,
          authorizationId: testId(),
          captureImmediately: true,
        }),
      ),
    );

    const permitted = results.filter((r) => r.outcome === "permitted");
    const denied = results.filter((r) => r.outcome === "denied");

    expect(permitted).toHaveLength(3);
    expect(denied).toHaveLength(17);

    // Not one paisa over.
    const spend = await spendOf(sql, openJti);
    expect(spend?.spent).toEqual(amount(30_000n));
    expect(spend?.actions).toBe(3);

    // And the ledger agrees with the accounting.
    expect(await balanceOf(sql, "asset:authorization_holds", INR)).toEqual(amount(30_000n));
  });

  it("hands every winner a distinct, contiguous accounting window", async () => {
    // spentBefore/spentAfter are what make an omitted audit record detectable.
    // If two winners reported the same spentBefore, the chain would have a
    // duplicate rather than a discontinuity, and omission would hide in it.
    const openJti = testId();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        attemptSpend(sql, {
          openJti,
          closedJti: testId(),
          constraints: CONSTRAINTS,
          request: REQUEST,
          now: NOW,
          authorizationId: testId(),
          captureImmediately: true,
        }),
      ),
    );

    const windows = results
      .filter((r) => r.outcome === "permitted")
      .map((r) => [r.spentBefore.amount, r.spentAfter.amount] as const)
      .sort((a, b) => Number(a[0] - b[0]));

    expect(windows).toEqual([
      [0n, 10_000n],
      [10_000n, 20_000n],
      [20_000n, 30_000n],
    ]);
  });
});

describe("replay protection", () => {
  it("spends a closed mandate exactly once, even under concurrency", async () => {
    const openJti = testId();
    const closedJti = testId();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        attemptSpend(sql, {
          openJti,
          closedJti,
          constraints: CONSTRAINTS,
          request: REQUEST,
          now: NOW,
          authorizationId: testId(),
          captureImmediately: true,
        }).catch((error: unknown) => ({ outcome: "error" as const, error })),
      ),
    );

    expect(results.filter((r) => r.outcome === "permitted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "replayed")).toHaveLength(7);

    const spend = await spendOf(sql, openJti);
    expect(spend?.spent).toEqual(amount(10_000n));
  });

  it("keeps the guard after a denial, so a refusal cannot be retried into a success", async () => {
    // Otherwise an agent parks a denied mandate and retries it until a
    // concurrent capture frees budget.
    const openJti = testId();
    const closedJti = testId();
    const tooBig = { ...REQUEST, amount: amount(999_999n) };

    const first = await attemptSpend(sql, {
      openJti,
      closedJti,
      constraints: CONSTRAINTS,
      request: tooBig,
      now: NOW,
      authorizationId: testId(),
    });
    expect(first.outcome).toBe("denied");

    const second = await attemptSpend(sql, {
      openJti,
      closedJti,
      constraints: CONSTRAINTS,
      request: REQUEST,
      now: NOW,
      authorizationId: testId(),
    });
    expect(second.outcome).toBe("replayed");
  });

  it("reports what a denial would have done", async () => {
    const result = await attemptSpend(sql, {
      openJti: testId(),
      closedJti: testId(),
      constraints: CONSTRAINTS,
      request: { ...REQUEST, amount: amount(50_000n) },
      now: NOW,
      authorizationId: testId(),
    });

    expect(result.outcome).toBe("denied");
    if (result.outcome !== "denied") return;

    // A DENY record has to be as informative as an ALLOW one.
    expect(result.spentBefore).toEqual(zero(INR));
    expect(result.spentAfter).toEqual(amount(50_000n));
    expect(result.decision.decidedBy).toBe("R-AMT-INR");
  });
});

describe("AP2's one-in-flight rule", () => {
  it("permits only one outstanding authorization per mandate", async () => {
    const openJti = testId();

    const first = await attemptSpend(sql, {
      openJti,
      closedJti: testId(),
      constraints: CONSTRAINTS,
      request: REQUEST,
      now: NOW,
      authorizationId: testId(),
    });
    expect(first.outcome).toBe("permitted");

    await expect(
      attemptSpend(sql, {
        openJti,
        closedJti: testId(),
        constraints: CONSTRAINTS,
        request: REQUEST,
        now: NOW,
        authorizationId: testId(),
      }),
    ).resolves.toMatchObject({ outcome: "already_in_flight", openJti });
  });

  it("rolls the replay guard back when one-in-flight refuses", async () => {
    // Nothing was authorised, so the closed mandate has not been spent and
    // must remain usable once the outstanding authorization clears.
    const openJti = testId();
    const closedJti = testId();

    const first = await attemptSpend(sql, {
      openJti,
      closedJti: testId(),
      constraints: CONSTRAINTS,
      request: REQUEST,
      now: NOW,
      authorizationId: testId(),
    });
    if (first.outcome !== "permitted") throw new Error("expected the first to be permitted");

    await expect(
      attemptSpend(sql, {
        openJti,
        closedJti,
        constraints: CONSTRAINTS,
        request: REQUEST,
        now: NOW,
        authorizationId: testId(),
      }),
    ).resolves.toMatchObject({ outcome: "already_in_flight", openJti });

    const consumed = await sql`SELECT 1 FROM consumed_mandates WHERE closed_jti = ${closedJti}`;
    expect(consumed).toHaveLength(0);

    await sql`UPDATE authorizations SET state = 'captured' WHERE id = ${first.authorizationId}`;

    const retried = await attemptSpend(sql, {
      openJti,
      closedJti,
      constraints: CONSTRAINTS,
      request: REQUEST,
      now: NOW,
      authorizationId: testId(),
    });
    expect(retried.outcome).toBe("permitted");
  });
});

describe("idempotency", () => {
  const body = { amount: 10_000, payee: "vnd_1042" };

  it("lets exactly one of many concurrent claims proceed", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        claim(sql, { actorId: "agent:pricing-bot", key: "idem-1", request: body }),
      ),
    );

    expect(results.filter((r) => r.kind === "proceed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "inFlight")).toHaveLength(11);
  });

  it("replays the stored response once the work is done", async () => {
    const key = "idem-2";
    const first = await claim(sql, { actorId: "a", key, request: body });
    expect(first.kind).toBe("proceed");

    await complete(sql, "a", key, 201, { order_id: "order_abc" });

    const second = await claim(sql, { actorId: "a", key, request: body });
    expect(second).toEqual({ kind: "replay", status: 201, body: { order_id: "order_abc" } });
  });

  it("reports a reused key with a different body instead of serving the old response", async () => {
    const key = "idem-3";
    await claim(sql, { actorId: "a", key, request: body });
    await complete(sql, "a", key, 201, { order_id: "order_abc" });

    const reused = await claim(sql, { actorId: "a", key, request: { ...body, amount: 999 } });
    expect(reused).toEqual({ kind: "mismatch" });
  });

  it("detects a mismatched body even while the first request is still running", async () => {
    const key = "idem-4";
    await claim(sql, { actorId: "a", key, request: body });

    expect(await claim(sql, { actorId: "a", key, request: { ...body, amount: 1 } })).toEqual({
      kind: "mismatch",
    });
  });

  it("returns a non-zero Retry-After while a request is in flight", async () => {
    const key = "idem-5";
    await claim(sql, { actorId: "a", key, request: body, leaseSeconds: 30 });

    const busy = await claim(sql, { actorId: "a", key, request: body });
    expect(busy.kind).toBe("inFlight");
    if (busy.kind !== "inFlight") return;

    // Zero would invite an immediate hot retry against a live request.
    expect(busy.retryAfterSeconds).toBeGreaterThan(0);
    expect(busy.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("lets a later attempt take over an expired lease", async () => {
    const key = "idem-6";
    await claim(sql, { actorId: "a", key, request: body, leaseSeconds: 0 });

    // The holder is presumed dead; recovery must not need an external reaper.
    const takeover = await claim(sql, { actorId: "a", key, request: body });
    expect(takeover.kind).toBe("proceed");
  });

  it("gives only one of several concurrent takeovers the expired lease", async () => {
    const key = "idem-7";
    await claim(sql, { actorId: "a", key, request: body, leaseSeconds: 0 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => claim(sql, { actorId: "a", key, request: body })),
    );

    expect(results.filter((r) => r.kind === "proceed")).toHaveLength(1);
  });

  it("scopes keys by actor, so one agent cannot collide with another", async () => {
    await claim(sql, { actorId: "agent:a", key: "shared", request: body });
    expect(await claim(sql, { actorId: "agent:b", key: "shared", request: body })).toMatchObject({
      kind: "proceed",
    });
  });

  it("records a failure so a retry learns the outcome", async () => {
    const key = "idem-8";
    await claim(sql, { actorId: "a", key, request: body });
    await complete(sql, "a", key, 502, { error: "gateway_unavailable" });

    expect(await claim(sql, { actorId: "a", key, request: body })).toMatchObject({
      kind: "replay",
      status: 502,
    });
  });

  it("reaps only leases that actually expired", async () => {
    await claim(sql, { actorId: "a", key: "live", request: body, leaseSeconds: 60 });
    await claim(sql, { actorId: "a", key: "dead", request: body, leaseSeconds: 0 });

    expect(await reapExpiredLeases(sql)).toBe(1);
    expect(await claim(sql, { actorId: "a", key: "live", request: body })).toMatchObject({
      kind: "inFlight",
    });
  });
});

describe("challenge nonces", () => {
  it("redeems a nonce exactly once under concurrency", async () => {
    const { nonce } = await issue(sql, "agent:pricing-bot");

    const results = await Promise.all(Array.from({ length: 10 }, () => consume(sql, nonce)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);
  });

  it("distinguishes unknown, spent and expired", async () => {
    const { nonce } = await issue(sql, "agent:a");
    await consume(sql, nonce);

    expect(await consume(sql, nonce)).toEqual({ ok: false, reason: "already_used" });
    expect(await consume(sql, "never-issued")).toEqual({ ok: false, reason: "unknown" });

    // Backdated rather than issued with a zero TTL. The schema refuses to
    // issue a nonce that is already dead, which is a constraint worth keeping,
    // so the test manufactures the expired state instead of weakening it.
    // Both columns move, since the constraint holds on UPDATE too — a nonce
    // that expired before it was issued is incoherent whichever way it got
    // that way.
    const { nonce: stale } = await issue(sql, "agent:a");
    await sql`
      UPDATE nonces
         SET issued_at = now() - interval '10 seconds',
             expires_at = now() - interval '1 second'
       WHERE nonce = ${stale}
    `;

    expect(await consume(sql, stale)).toEqual({ ok: false, reason: "expired" });
  });

  it("issues unpredictable values", async () => {
    const issued = await Promise.all(
      Array.from({ length: 50 }, () => issue(sql, "agent:a").then((n) => n.nonce)),
    );

    expect(new Set(issued).size).toBe(50);
    expect(issued.every((n) => n.length >= 16)).toBe(true);
  });
});
