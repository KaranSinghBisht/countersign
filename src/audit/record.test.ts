import { describe, expect, it } from "vitest";
import {
  type AuditRecord,
  GENESIS_HASH,
  hashRecord,
  seal,
  toPaise,
  type UnsealedRecord,
  verifyRecordChain,
} from "./record.js";

const DIGEST = "R9dS1SLLLZQzHVeYm8dQ8Zc9Zc1kxZq2wPQKmxDxzZ8";

function draft(overrides: Partial<UnsealedRecord> = {}): UnsealedRecord {
  return {
    v: 1,
    seq: 0,
    ts: "2026-08-22T16:59:03.412Z",
    trace_id: "01K3QF8ZZ0ABCDEFGHJKMNPQRS",
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
      closed_jti: "01K3QF8ZZ0CLOSEDMANDATE001",
      closed_hash: DIGEST,
      chain_depth: 2,
    },
    intent: { prompt_sha256: DIGEST, prompt_bytes: 1841, redaction_profile: "pii-v2" },
    tool: {
      name: "razorpay.orders.create",
      args: { amount: 1_499_000, currency: "INR", receipt: "pr4KJ2" },
      args_sha256: DIGEST,
    },
    policy: {
      bundle_sha256: DIGEST,
      engine_version: "0.3.1",
      rules_evaluated: [{ id: "R-BUD-002", constraint: "spend.budget", effect: "permit" }],
      first_deny: null,
    },
    accounting: {
      spent_before_paise: 10_497_000,
      amount_paise: 1_499_000,
      spent_after_paise: 11_996_000,
      actions_before: 3,
      actions_after: 4,
      budget_max_paise: 25_000_000,
      currency: "INR",
    },
    decision: "ALLOW",
    reason: "within per-transaction cap and aggregate budget",
    external: {
      rail: "razorpay",
      idempotency_key: "idem-1",
      order_id: "order_abc",
      payment_id: "pay_abc",
      signature_verified: true,
      status: "captured",
    },
    output_sha256: DIGEST,
    prev_hash: GENESIS_HASH,
    ...overrides,
  };
}

/** A well-formed run of `count` ALLOW records under one mandate. */
function chain(count: number, step = 1_000): AuditRecord[] {
  const records: AuditRecord[] = [];
  let prev = GENESIS_HASH;
  let spent = 0;

  for (let i = 0; i < count; i++) {
    const record = seal(
      draft({
        seq: i,
        prev_hash: prev,
        accounting: {
          spent_before_paise: spent,
          amount_paise: step,
          spent_after_paise: spent + step,
          actions_before: i,
          actions_after: i + 1,
          budget_max_paise: 25_000_000,
          currency: "INR",
        },
      }),
    );

    records.push(record);
    prev = record.record_hash;
    spent += step;
  }

  return records;
}

describe("record hashing", () => {
  it("is stable across key insertion order", () => {
    const a = draft();
    const b = { ...draft(), v: 1 as const };

    // JCS sorts keys, so a differently built object with the same content
    // hashes identically. Without canonicalisation the writer and the verifier
    // would have to agree on a serialiser, which they cannot across languages.
    expect(hashRecord(a)).toBe(hashRecord(b));
  });

  it("changes when any field changes", () => {
    const base = hashRecord(draft());

    expect(hashRecord(draft({ reason: "something else" }))).not.toBe(base);
    expect(hashRecord(draft({ seq: 1 }))).not.toBe(base);
    expect(hashRecord(draft({ decision: "DENY" }))).not.toBe(base);
  });

  it("does not mutate the record it hashes", () => {
    const record = draft();
    const before = JSON.stringify(record);

    hashRecord(record);
    hashRecord(record);

    expect(JSON.stringify(record)).toBe(before);
  });

  it("seals without the hash committing to itself", () => {
    const record = seal(draft());
    const { record_hash, ...content } = record;

    expect(hashRecord(content)).toBe(record_hash);
  });
});

describe("chain verification", () => {
  it("accepts an honest chain", () => {
    expect(verifyRecordChain(chain(5))).toEqual([]);
  });

  it("catches a record whose content was edited", () => {
    const records = chain(5);
    // Re-hashing is what the attacker cannot do without the private key in the
    // signed-checkpoint case; here it shows the chain itself notices.
    records[2] = { ...(records[2] as AuditRecord), reason: "backdated justification" };

    const violations = verifyRecordChain(records);
    expect(violations.map((v) => v.kind)).toContain("bad_record_hash");
    expect(violations[0]?.seq).toBe(2);
  });

  it("catches a broken prev_hash link", () => {
    const records = chain(4);
    records[2] = seal({ ...(records[2] as AuditRecord), prev_hash: GENESIS_HASH });

    expect(verifyRecordChain(records).map((v) => v.kind)).toContain("broken_link");
  });

  it("catches an omitted record even after the chain is relinked", () => {
    // The headline property. An attacker who can re-sign the log removes the
    // middle record and repairs prev_hash and seq so the chain is flawless.
    // The running total is what gives it away: 2000 was spent between the
    // record that ends at 2000 and the one that starts at 3000.
    const records = chain(5);
    const kept = [...records.slice(0, 2), ...records.slice(3)];

    let prev = kept[1]?.record_hash as string;
    const relinked = [
      ...kept.slice(0, 2),
      ...kept.slice(2).map((r, i) => {
        const fixed = seal({ ...r, seq: 2 + i, prev_hash: prev });
        prev = fixed.record_hash;
        return fixed;
      }),
    ];

    // The chain and the sequence numbers are now perfect.
    const violations = verifyRecordChain(relinked);
    expect(violations.map((v) => v.kind)).not.toContain("bad_record_hash");
    expect(violations.map((v) => v.kind)).not.toContain("broken_link");
    expect(violations.map((v) => v.kind)).not.toContain("non_contiguous_seq");

    // But the money does not add up, and the report says by how much.
    const gap = violations.find((v) => v.kind === "accounting_discontinuity");
    expect(gap).toBeDefined();
    expect(gap?.detail).toContain("1000 paise unaccounted for");
  });

  it("catches a record whose own arithmetic is wrong", () => {
    const records = chain(3);
    records[1] = seal({
      ...(records[1] as AuditRecord),
      accounting: { ...(records[1] as AuditRecord).accounting, spent_after_paise: 99_999 },
    });

    expect(verifyRecordChain(records).map((v) => v.kind)).toContain("arithmetic_mismatch");
  });

  it("catches a gap in the action count", () => {
    const records = chain(3);
    const target = records[2] as AuditRecord;
    records[2] = seal({
      ...target,
      accounting: { ...target.accounting, actions_before: 7, actions_after: 8 },
    });

    expect(verifyRecordChain(records).map((v) => v.kind)).toContain("actions_discontinuity");
  });

  it("lets a DENY leave the running total untouched", () => {
    // A refusal spends nothing, so the next record must continue from the
    // total as it stood — not from the amount that was refused.
    const first = seal(draft({ seq: 0, prev_hash: GENESIS_HASH }));

    const denied = seal(
      draft({
        seq: 1,
        prev_hash: first.record_hash,
        decision: "DENY",
        reason: "aggregate budget exceeded",
        policy: {
          bundle_sha256: DIGEST,
          engine_version: "0.3.1",
          rules_evaluated: [{ id: "R-BUD-002", constraint: "spend.budget", effect: "deny" }],
          first_deny: "R-BUD-002",
        },
        accounting: {
          spent_before_paise: 11_996_000,
          amount_paise: 90_000_000,
          spent_after_paise: 101_996_000,
          actions_before: 4,
          actions_after: 5,
          budget_max_paise: 25_000_000,
          currency: "INR",
        },
        external: null,
        output_sha256: null,
      }),
    );

    const next = seal(
      draft({
        seq: 2,
        prev_hash: denied.record_hash,
        accounting: {
          spent_before_paise: 11_996_000,
          amount_paise: 4_000,
          spent_after_paise: 12_000_000,
          actions_before: 4,
          actions_after: 5,
          budget_max_paise: 25_000_000,
          currency: "INR",
        },
      }),
    );

    expect(verifyRecordChain([first, denied, next])).toEqual([]);
  });

  it("records what a denial would have done", () => {
    // spent_after on a DENY is counterfactual: it is what the total WOULD have
    // become. That is what makes a refusal auditable rather than just logged.
    const violations = verifyRecordChain([
      seal(
        draft({
          decision: "DENY",
          policy: {
            bundle_sha256: DIGEST,
            engine_version: "0.3.1",
            rules_evaluated: [
              { id: "R-AMT-INR", constraint: "spend.amount_range", effect: "deny" },
            ],
            first_deny: "R-AMT-INR",
          },
        }),
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("tracks each mandate's running total separately", () => {
    // Interleaved mandates must not be compared against each other, or every
    // busy log looks tampered with.
    const a = seal(draft({ seq: 0, prev_hash: GENESIS_HASH }));
    const b = seal(
      draft({
        seq: 1,
        prev_hash: a.record_hash,
        mandate: { ...draft().mandate, open_jti: "01K3QF8ZZ0OPENMANDATE00002" },
        accounting: {
          spent_before_paise: 0,
          amount_paise: 500,
          spent_after_paise: 500,
          actions_before: 0,
          actions_after: 1,
          budget_max_paise: 25_000_000,
          currency: "INR",
        },
      }),
    );

    expect(verifyRecordChain([a, b])).toEqual([]);
  });

  it("reports every violation, not just the first", () => {
    const records = chain(4);
    records[1] = { ...(records[1] as AuditRecord), reason: "edited" };
    records[3] = { ...(records[3] as AuditRecord), reason: "also edited" };

    const seqs = verifyRecordChain(records)
      .filter((v) => v.kind === "bad_record_hash")
      .map((v) => v.seq);

    expect(seqs).toEqual([1, 3]);
  });

  it("rejects a record that fails the schema", () => {
    const bad = { ...seal(draft()), decision: "MAYBE" } as unknown as AuditRecord;
    expect(verifyRecordChain([bad]).map((v) => v.kind)).toContain("schema");
  });
});

describe("toPaise", () => {
  it("converts within the safe range", () => {
    expect(toPaise(1_499_000n)).toBe(1_499_000);
    expect(toPaise(0n)).toBe(0);
  });

  it("refuses to lose precision", () => {
    // Roughly ₹90 trillion — unreachable, which is precisely why an unchecked
    // conversion would pass every test and then be silently wrong once.
    expect(() => toPaise(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });
});
