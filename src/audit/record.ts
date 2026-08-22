/**
 * Audit record schema and the hash chain over it.
 *
 *   record_hash = b64u(SHA256(JCS(record without record_hash)))
 *
 * Canonicalising with RFC 8785 before hashing is what lets the writer and the
 * verifier agree without also agreeing on a serialiser. Key order, whitespace
 * and number formatting all stop mattering.
 *
 * Two asymmetries in this schema are deliberate.
 *
 * The prompt is hashed; tool arguments are not. Prompts carry addresses, phone
 * numbers and order history, and this record is designed to be exported to
 * third parties — a hash lets the integrity-evidence retention clock and the
 * personal-data retention clock run independently. Tool arguments *are* the
 * money action being audited: structured, bounded, non-personal. "Every money
 * action explainable" means a human reads the record and understands what
 * happened without querying our database. The cost is real and worth stating:
 * a hash proves nothing about content unless someone kept the content.
 *
 * Every record carries `spent_before` / `amount` / `spent_after`. Those three
 * integers are what turn record omission from undetectable into detectable —
 * drop a record from the middle and the running total has a visible
 * discontinuity. A hash chain alone does not give you this: an attacker who
 * can re-sign the log can drop a record and re-link the chain cleanly. Neither
 * AP2 nor Verifiable Intent commits the running total into the evidence.
 */

import { z } from "zod";
import { canonical, type JsonValue } from "../crypto/canonical.js";
import { digestJson } from "../crypto/digest.js";

export const RECORD_VERSION = 1;

/**
 * `prev_hash` of the first record.
 *
 * A distinguished constant rather than null or an empty string, so that "this
 * is the genesis record" is itself a signed claim. If genesis were null, an
 * attacker could truncate the log to any point and present the survivor as the
 * beginning.
 */
export const GENESIS_HASH = "countersign/v1/genesis";

const Decision = z.enum(["ALLOW", "DENY", "ESCALATE"]);

/** Base64url SHA-256, 43 characters unpadded. */
const Digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected an unpadded base64url SHA-256");

const NonNegative = z.number().int().nonnegative();

export const AuditRecordSchema = z
  .object({
    v: z.literal(RECORD_VERSION),
    seq: NonNegative,
    ts: z.string().datetime({ offset: false }),
    trace_id: z.string().min(1),

    actor: z.object({
      principal_id: z.string().min(1),
      agent_id: z.string().min(1),
      agent_version: z.string().min(1),
      model: z.string().min(1),
      runtime_sha256: Digest,
    }),

    mandate: z.object({
      open_jti: z.string().min(1),
      open_hash: Digest,
      closed_jti: z.string().min(1),
      closed_hash: Digest,
      chain_depth: z.number().int().min(1).max(2),
    }),

    intent: z.object({
      prompt_sha256: Digest,
      prompt_bytes: NonNegative,
      redaction_profile: z.string().min(1),
    }),

    tool: z.object({
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()),
      args_sha256: Digest,
    }),

    policy: z.object({
      bundle_sha256: Digest,
      engine_version: z.string().min(1),
      rules_evaluated: z.array(
        z.object({
          id: z.string().min(1),
          constraint: z.string().min(1),
          effect: z.enum(["permit", "deny", "escalate"]),
        }),
      ),
      // The rule that refused, by id. Null on an ALLOW.
      first_deny: z.string().min(1).nullable(),
    }),

    accounting: z.object({
      spent_before_paise: NonNegative,
      amount_paise: NonNegative,
      spent_after_paise: NonNegative,
      actions_before: NonNegative,
      actions_after: NonNegative,
      budget_max_paise: NonNegative.nullable(),
      currency: z.string().length(3),
    }),

    decision: Decision,
    reason: z.string().min(1),

    external: z
      .object({
        rail: z.string().min(1),
        idempotency_key: z.string().min(1),
        order_id: z.string().nullable(),
        payment_id: z.string().nullable(),
        signature_verified: z.boolean(),
        status: z.string().min(1),
      })
      .nullable(),

    output_sha256: Digest.nullable(),
    prev_hash: z.string().min(1),
    record_hash: Digest,
  })
  .strict();

export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/** A record with everything except the hash that commits to it. */
export type UnsealedRecord = Omit<AuditRecord, "record_hash">;

/**
 * Hash a record's content.
 *
 * `record_hash` is stripped rather than assumed absent. A hash cannot commit
 * to itself, and the types alone do not prevent the mistake: spreading a
 * sealed record into a patch (`{ ...record, seq: 4 }`) produces something that
 * satisfies `UnsealedRecord` structurally while still carrying the old hash.
 * Hashing that yields a value which will never verify, and the failure looks
 * like tampering rather than like a bug.
 *
 * Destructured into a fresh object rather than deleted from the caller's, so
 * the same input always hashes the same way.
 */
export function hashRecord(record: UnsealedRecord): string {
  const { record_hash: _ignored, ...content } = record as Partial<AuditRecord>;
  return digestJson(content as unknown as JsonValue);
}

export function seal(record: UnsealedRecord): AuditRecord {
  return { ...record, record_hash: hashRecord(record) };
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

export interface ChainViolation {
  readonly seq: number;
  readonly kind:
    | "bad_record_hash"
    | "broken_link"
    | "non_contiguous_seq"
    | "accounting_discontinuity"
    | "actions_discontinuity"
    | "arithmetic_mismatch"
    | "schema";
  readonly detail: string;
}

/**
 * Check a run of records end to end.
 *
 * Every violation is collected rather than thrown on, because the useful
 * output of a verifier is "here is everything wrong and exactly where", not
 * "the first thing I noticed". A judge holding a tampered bundle should be
 * told the sequence number and the delta.
 */
export function verifyRecordChain(records: readonly AuditRecord[]): ChainViolation[] {
  const violations: ChainViolation[] = [];

  // Running totals per mandate. The chain links records globally; the
  // accounting links them per open mandate, which is the axis an attacker
  // would tamper along.
  const lastSpend = new Map<string, { after: number; actions: number; seq: number }>();

  let previousHash = GENESIS_HASH;
  let expectedSeq = records[0]?.seq ?? 0;

  for (const record of records) {
    const parsed = AuditRecordSchema.safeParse(record);
    if (!parsed.success) {
      violations.push({
        seq: record.seq,
        kind: "schema",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }

    const { record_hash, ...content } = record;

    const recomputed = hashRecord(content);
    if (recomputed !== record_hash) {
      violations.push({
        seq: record.seq,
        kind: "bad_record_hash",
        detail: `record_hash is ${record_hash} but its content hashes to ${recomputed}`,
      });
    }

    if (record.prev_hash !== previousHash) {
      violations.push({
        seq: record.seq,
        kind: "broken_link",
        detail: `prev_hash is ${record.prev_hash}, expected ${previousHash}`,
      });
    }

    if (record.seq !== expectedSeq) {
      violations.push({
        seq: record.seq,
        kind: "non_contiguous_seq",
        detail: `expected seq ${expectedSeq}`,
      });
    }

    const acct = record.accounting;

    // Internal arithmetic. A record whose own numbers do not add up is
    // broken regardless of what its neighbours say.
    if (acct.spent_before_paise + acct.amount_paise !== acct.spent_after_paise) {
      violations.push({
        seq: record.seq,
        kind: "arithmetic_mismatch",
        detail:
          `${acct.spent_before_paise} + ${acct.amount_paise} = ` +
          `${acct.spent_before_paise + acct.amount_paise}, but spent_after is ${acct.spent_after_paise}`,
      });
    }

    // Continuity against the previous record for the same mandate. This is
    // the check that makes an omitted record visible.
    const previous = lastSpend.get(record.mandate.open_jti);
    if (previous !== undefined) {
      if (previous.after !== acct.spent_before_paise) {
        violations.push({
          seq: record.seq,
          kind: "accounting_discontinuity",
          detail:
            `spent_before is ${acct.spent_before_paise} but seq ${previous.seq} ` +
            `left the running total at ${previous.after} — ` +
            `${acct.spent_before_paise - previous.after} paise unaccounted for`,
        });
      }

      if (previous.actions !== acct.actions_before) {
        violations.push({
          seq: record.seq,
          kind: "actions_discontinuity",
          detail: `actions_before is ${acct.actions_before}, expected ${previous.actions}`,
        });
      }
    }

    // Only a permitted action moves the totals, so a DENY leaves the
    // running total where it was and the next record must agree with THAT.
    lastSpend.set(record.mandate.open_jti, {
      after: record.decision === "ALLOW" ? acct.spent_after_paise : acct.spent_before_paise,
      actions: record.decision === "ALLOW" ? acct.actions_after : acct.actions_before,
      seq: record.seq,
    });

    previousHash = record_hash;
    expectedSeq = record.seq + 1;
  }

  return violations;
}

/**
 * Convert minor units to the JSON number the schema uses.
 *
 * JCS has no bigint, so the record has to carry a number, and a number silently
 * loses precision past 2^53. At paise that is about ₹90 trillion — unreachable
 * in practice, which is exactly why an unchecked conversion would survive
 * every test and then be wrong once.
 */
export function toPaise(minor: bigint): number {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${minor} exceeds the range JSON can represent exactly`);
  }
  return Number(minor);
}

/** The bytes a verifier hashes. Exposed so a bundle can be checked offline. */
export function canonicalRecord(record: UnsealedRecord): string {
  return canonical(record as unknown as JsonValue);
}
