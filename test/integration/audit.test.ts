import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verify as verifyNote } from "../../src/audit/checkpoint.js";
import {
  type AppendInput,
  append,
  latestCheckpoint,
  proveConsistency,
  proveInclusion,
  publishCheckpoint,
  read,
  readByOrder,
  selfCheck,
  size,
  treeRoot,
} from "../../src/audit/log.js";
import { leafHash, verifyConsistency, verifyInclusion } from "../../src/audit/merkle.js";
import { GENESIS_HASH, toPaise } from "../../src/audit/record.js";
import { b64, hex, utf8 } from "../../src/crypto/encoding.js";
import { generateKey, importPublicKey, type KeyPair } from "../../src/crypto/keys.js";
import type { Sql } from "../../src/db/client.js";
import { ensureAccounts } from "../../src/ledger/ledger.js";
import { type Constraint, ConstraintSchema } from "../../src/mandate/constraints.js";
import { money } from "../../src/money/money.js";
import { attemptSpend } from "../../src/spend/accounting.js";
import { migrateOnce, testDb, testId, truncateAll } from "./helpers.js";

let sql: Sql;
let key: KeyPair;

const INR = "INR" as const;
const NOW = 1_755_700_500;
const ORIGIN = "countersign.dev/audit";
const KEY_NAME = "countersign.dev/audit";
const DIGEST = "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8";

const CONSTRAINTS: Constraint[] = [
  { type: "spend.amount_range", currency: "INR", min: 0, max: 10_000 },
  { type: "spend.budget", currency: "INR", max: 30_000 },
].map((c) => ConstraintSchema.parse(c));

const REQUEST = {
  amount: money(10_000n, INR),
  payee: { id: "vnd_1042" },
  rail: "razorpay_order",
};

function entry(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
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
      open_jti: "01K3QF8ZZ0OPENMANDATE00001",
      open_hash: DIGEST,
      closed_jti: testId(),
      closed_hash: DIGEST,
      chain_depth: 2,
    },
    intent: { prompt_sha256: DIGEST, prompt_bytes: 1841, redaction_profile: "pii-v2" },
    tool: { name: "razorpay.orders.create", args: { amount: 10_000 }, args_sha256: DIGEST },
    policy: {
      bundle_sha256: DIGEST,
      engine_version: "0.3.1",
      rules_evaluated: [{ id: "R-BUD-INR", constraint: "spend.budget", effect: "permit" }],
      first_deny: null,
    },
    accounting: {
      spent_before_paise: 0,
      amount_paise: 10_000,
      spent_after_paise: 10_000,
      actions_before: 0,
      actions_after: 1,
      budget_max_paise: 30_000,
      currency: "INR",
    },
    decision: "ALLOW",
    reason: "within budget",
    external: null,
    output_sha256: null,
    ...overrides,
  };
}

/** Append `n` well-formed records under one mandate, with a coherent total. */
async function appendRun(n: number, openJti = "01K3QF8ZZ0OPENMANDATE00001") {
  const out = [];
  for (let i = 0; i < n; i++) {
    const record = await sql.begin((tx) =>
      append(tx, {
        ...entry(),
        mandate: { ...entry().mandate, open_jti: openJti, closed_jti: testId() },
        accounting: {
          spent_before_paise: i * 10_000,
          amount_paise: 10_000,
          spent_after_paise: (i + 1) * 10_000,
          actions_before: i,
          actions_after: i + 1,
          budget_max_paise: 30_000_000,
          currency: "INR",
        },
      }),
    );
    out.push(record);
  }
  return out;
}

beforeAll(async () => {
  sql = testDb();
  await migrateOnce(sql);
  key = await generateKey("Ed25519");
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await truncateAll(sql);
  await ensureAccounts(sql, INR);
});

describe("appending", () => {
  it("starts the chain at genesis", async () => {
    const record = await sql.begin((tx) => append(tx, entry()));

    expect(record.seq).toBe(0);
    expect(record.prev_hash).toBe(GENESIS_HASH);
  });

  it("assigns gapless sequence numbers and links each record to the last", async () => {
    const records = await appendRun(5);

    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < records.length; i++) {
      expect(records[i]?.prev_hash).toBe(records[i - 1]?.record_hash);
    }
    expect(await selfCheck(sql)).toEqual([]);
  });

  it("keeps sequence numbers gapless when a transaction rolls back", async () => {
    // The reason the head row is a locked row and not a SEQUENCE. A sequence
    // burns its number on rollback, and a gap in an audit log is
    // indistinguishable from a deletion.
    await appendRun(2);

    await expect(
      sql.begin(async (tx) => {
        await append(tx, entry());
        throw new Error("something went wrong after the append");
      }),
    ).rejects.toThrow("something went wrong");

    const next = await sql.begin((tx) =>
      append(tx, {
        ...entry(),
        accounting: {
          spent_before_paise: 20_000,
          amount_paise: 10_000,
          spent_after_paise: 30_000,
          actions_before: 2,
          actions_after: 3,
          budget_max_paise: 30_000_000,
          currency: "INR",
        },
      }),
    );

    expect(next.seq).toBe(2);
    expect(await size(sql)).toBe(3);
    expect(await selfCheck(sql)).toEqual([]);
  });

  it("serializes concurrent appends into one well-formed chain", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sql.begin((tx) =>
          append(tx, {
            ...entry(),
            mandate: { ...entry().mandate, open_jti: `mandate-${i}`, closed_jti: testId() },
          }),
        ),
      ),
    );

    const records = await read(sql);
    expect(records.map((r) => r.seq)).toEqual([...Array(12).keys()]);

    // Each mandate is distinct, so the per-mandate running totals never
    // interact and the whole chain must verify.
    expect(await selfCheck(sql)).toEqual([]);
  });

  it("refuses to store a malformed record", async () => {
    // The table refuses UPDATE and DELETE, so a bad record can never be
    // removed. Validation has to happen before the insert, not after.
    await expect(
      sql.begin((tx) =>
        append(tx, { ...entry(), decision: "MAYBE" as unknown as AppendInput["decision"] }),
      ),
    ).rejects.toThrow(/malformed audit record/);

    expect(await size(sql)).toBe(0);
  });

  it("refuses to rewrite or delete a record", async () => {
    const record = await sql.begin((tx) => append(tx, entry()));

    await expect(
      sql`UPDATE audit_records SET decision = 'DENY' WHERE seq = ${record.seq}`,
    ).rejects.toThrow(/append-only/);

    await expect(sql`DELETE FROM audit_records WHERE seq = ${record.seq}`).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("atomicity with the spend", () => {
  it("commits the audit record in the same transaction as the spend", async () => {
    const openJti = testId();

    const result = await attemptSpend(sql, {
      openJti,
      closedJti: testId(),
      constraints: CONSTRAINTS,
      request: REQUEST,
      now: NOW,
      authorizationId: testId(),
      onDecision: async (tx, outcome) => {
        await append(tx, {
          ...entry(),
          mandate: { ...entry().mandate, open_jti: openJti, closed_jti: testId() },
          decision: outcome.decision.effect === "permit" ? "ALLOW" : "DENY",
          accounting: {
            spent_before_paise: toPaise(outcome.spentBefore.amount),
            amount_paise: toPaise(outcome.amount.amount),
            spent_after_paise: toPaise(outcome.spentAfter.amount),
            actions_before: outcome.actionsBefore,
            actions_after: outcome.actionsAfter,
            budget_max_paise: 30_000,
            currency: "INR",
          },
        });
      },
    });

    expect(result.outcome).toBe("permitted");

    const records = await read(sql);
    expect(records).toHaveLength(1);
    expect(records[0]?.accounting.spent_after_paise).toBe(10_000);
  });

  it("writes no audit record when the spend rolls back", async () => {
    // If the log could commit while the spend failed, replaying the log would
    // no longer reproduce the balance.
    const openJti = testId();

    await expect(
      attemptSpend(sql, {
        openJti,
        closedJti: testId(),
        constraints: CONSTRAINTS,
        request: REQUEST,
        now: NOW,
        authorizationId: testId(),
        onDecision: async (tx) => {
          await append(tx, entry());
          throw new Error("audit write failed");
        },
      }),
    ).rejects.toThrow("audit write failed");

    expect(await size(sql)).toBe(0);
    const spend = await sql`SELECT 1 FROM mandate_spend WHERE open_jti = ${openJti}`;
    expect(spend).toHaveLength(0);
  });

  it("logs a denial as carefully as an approval", async () => {
    const openJti = testId();

    const result = await attemptSpend(sql, {
      openJti,
      closedJti: testId(),
      constraints: CONSTRAINTS,
      request: { ...REQUEST, amount: money(500_000n, INR) },
      now: NOW,
      authorizationId: testId(),
      onDecision: async (tx, outcome) => {
        await append(tx, {
          ...entry(),
          mandate: { ...entry().mandate, open_jti: openJti, closed_jti: testId() },
          decision: "DENY",
          reason: "exceeds the per-transaction cap",
          policy: {
            bundle_sha256: DIGEST,
            engine_version: "0.3.1",
            rules_evaluated: [
              { id: "R-AMT-INR", constraint: "spend.amount_range", effect: "deny" },
            ],
            first_deny: outcome.decision.decidedBy ?? "R-AMT-INR",
          },
          accounting: {
            spent_before_paise: toPaise(outcome.spentBefore.amount),
            amount_paise: toPaise(outcome.amount.amount),
            spent_after_paise: toPaise(outcome.spentAfter.amount),
            actions_before: outcome.actionsBefore,
            actions_after: outcome.actionsAfter,
            budget_max_paise: 30_000,
            currency: "INR",
          },
        });
      },
    });

    expect(result.outcome).toBe("denied");

    const [record] = await read(sql);
    expect(record?.decision).toBe("DENY");
    expect(record?.policy.first_deny).toBe("R-AMT-INR");
    // What WOULD have happened, which is what makes a refusal auditable.
    expect(record?.accounting.spent_after_paise).toBe(500_000);
  });
});

describe("proofs", () => {
  it("proves inclusion of every record against the current root", async () => {
    const records = await appendRun(7);
    const root = await treeRoot(sql);

    for (const record of records) {
      const evidence = await proveInclusion(sql, record.seq);

      expect(hex(evidence.leafHash)).toBe(hex(leafHash(utf8(record.record_hash))));
      expect(
        verifyInclusion(record.seq, evidence.treeSize, evidence.leafHash, evidence.proof, root),
        `seq ${record.seq}`,
      ).toBe(true);
    }
  });

  it("lets a receipt holder verify without the record body", async () => {
    // The leaf commits to the record hash, so someone holding only a receipt
    // can check inclusion without being shown data they are not entitled to.
    const records = await appendRun(5);
    const target = records[2];
    if (target === undefined) throw new Error("expected a record");

    const evidence = await proveInclusion(sql, 2);

    expect(
      verifyInclusion(
        2,
        evidence.treeSize,
        leafHash(utf8(target.record_hash)),
        evidence.proof,
        evidence.root,
      ),
    ).toBe(true);
  });

  it("proves the log only ever grew", async () => {
    await appendRun(3);
    const oldRoot = await treeRoot(sql);
    const oldSize = await size(sql);

    await appendRun(4, "01K3QF8ZZ0OPENMANDATE00002");
    const newRoot = await treeRoot(sql);

    const { proof } = await proveConsistency(sql, oldSize);

    expect(verifyConsistency(oldSize, await size(sql), oldRoot, newRoot, proof)).toBe(true);
  });

  it("refuses a proof for a record outside the log", async () => {
    await appendRun(3);
    await expect(proveInclusion(sql, 3)).rejects.toThrow(RangeError);
  });
});

describe("checkpoints", () => {
  it("signs the current tree and verifies against a pinned key", async () => {
    await appendRun(4);

    const { note } = await publishCheckpoint(sql, ORIGIN, KEY_NAME, key);
    const verified = await verifyNote(note, ORIGIN, KEY_NAME, await importPublicKey(key.publicJwk));

    expect(verified.size).toBe(4);
    expect(b64(verified.rootHash)).toBe(b64(await treeRoot(sql)));
  });

  it("is idempotent at an unchanged size", async () => {
    await appendRun(3);

    const first = await publishCheckpoint(sql, ORIGIN, KEY_NAME, key);
    const second = await publishCheckpoint(sql, ORIGIN, KEY_NAME, key);

    // Ed25519 is deterministic, so an unchanged tree re-signs to the same
    // bytes rather than to a new artifact that looks like a change.
    expect(second.note).toBe(first.note);

    const stored = await sql`SELECT tree_size FROM checkpoints`;
    expect(stored).toHaveLength(1);
  });

  it("keeps every checkpoint, not just the newest", async () => {
    // Retaining the history is what makes a fork detectable after the fact.
    await appendRun(2);
    await publishCheckpoint(sql, ORIGIN, KEY_NAME, key);

    await appendRun(2, "01K3QF8ZZ0OPENMANDATE00003");
    await publishCheckpoint(sql, ORIGIN, KEY_NAME, key);

    const sizes = await sql<{ tree_size: bigint }[]>`
      SELECT tree_size FROM checkpoints ORDER BY tree_size
    `;
    expect(sizes.map((s) => Number(s.tree_size))).toEqual([2, 4]);
  });

  it("reports the newest checkpoint", async () => {
    await appendRun(3);
    await publishCheckpoint(sql, ORIGIN, KEY_NAME, key);

    const latest = await latestCheckpoint(sql);
    expect(latest?.checkpoint.size).toBe(3);
    expect(latest?.checkpoint.origin).toBe(ORIGIN);
  });

  it("refuses to publish a second, different checkpoint at one size", async () => {
    await appendRun(2);

    // Plant a divergent checkpoint at the size we are about to publish — what
    // a split view looks like from the log's own side. It cannot be planted by
    // deleting and replacing ours, because the table refuses DELETE.
    await sql`
      INSERT INTO checkpoints (tree_size, root_hash, note)
      VALUES (2, ${Buffer.alloc(32, 7)}, 'countersign.dev/audit\n2\nforged\n')
    `;

    await expect(publishCheckpoint(sql, ORIGIN, KEY_NAME, key)).rejects.toThrow(/forked/);
  });
});

describe("querying", () => {
  it("finds every record for an order", async () => {
    const orderId = "order_abc123";

    await sql.begin((tx) =>
      append(tx, {
        ...entry(),
        external: {
          rail: "razorpay",
          idempotency_key: "idem-1",
          order_id: orderId,
          payment_id: null,
          signature_verified: false,
          status: "created",
        },
      }),
    );

    await sql.begin((tx) =>
      append(tx, {
        ...entry(),
        accounting: {
          spent_before_paise: 10_000,
          amount_paise: 10_000,
          spent_after_paise: 20_000,
          actions_before: 1,
          actions_after: 2,
          budget_max_paise: 30_000,
          currency: "INR",
        },
        external: {
          rail: "razorpay",
          idempotency_key: "idem-1",
          order_id: orderId,
          payment_id: "pay_abc",
          signature_verified: true,
          status: "captured",
        },
      }),
    );

    const records = await readByOrder(sql, orderId);
    expect(records.map((r) => r.external?.status)).toEqual(["created", "captured"]);
  });
});
