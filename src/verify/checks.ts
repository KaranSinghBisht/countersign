/**
 * The thirty checks.
 *
 * Grouped the way a reviewer reads them: is the log intact, were the mandates
 * real, was this the cart we quoted, did time and replay hold, were the
 * numbers inside the mandate, does Razorpay's receipt agree, and — same
 * `decide()` the server ran — would we reach the same verdict today.
 *
 * Failures name a `seq` and a delta. "something is wrong" is not a result.
 */

import {
  type Checkpoint,
  CheckpointError,
  verify as verifyCheckpoint,
} from "../audit/checkpoint.js";
import { inclusionProof, leafHash, root, verifyInclusion } from "../audit/merkle.js";
import { type AuditRecord, GENESIS_HASH, verifyRecordChain } from "../audit/record.js";
import type { JsonValue } from "../crypto/canonical.js";
import { hex, utf8 } from "../crypto/encoding.js";
import { hashJws, verifyChain } from "../mandate/verify.js";
import { CURRENCIES, type CurrencyCode, money } from "../money/money.js";
import { decide, type SpendState } from "../policy/engine.js";
import { deriveReceipt, isWellFormedReceipt } from "../razorpay/receipt.js";
import type { LoadedBundle } from "./bundle.js";
import type { Trust } from "./trust.js";

export const CHECK_GROUPS = [
  "log",
  "mandate",
  "request",
  "temporal",
  "bounds",
  "external",
  "policy",
] as const;

export type CheckGroup = (typeof CHECK_GROUPS)[number];

export interface CheckSpec {
  readonly id: string;
  readonly group: CheckGroup;
  readonly name: string;
}

/** The thirty. Adding one means updating this list and the runner together. */
export const CHECKS: readonly CheckSpec[] = [
  { id: "L1", group: "log", name: "records present and ordered" },
  { id: "L2", group: "log", name: "each record_hash matches its content" },
  { id: "L3", group: "log", name: "prev_hash chain from genesis" },
  { id: "L4", group: "log", name: "sequence numbers are gapless" },
  { id: "L5", group: "log", name: "spent_before + amount = spent_after" },
  { id: "L6", group: "log", name: "per-mandate spent continuity" },
  { id: "L7", group: "log", name: "per-mandate action continuity" },
  { id: "L8", group: "log", name: "Merkle root matches the checkpoint" },
  { id: "L9", group: "log", name: "inclusion proof for every record" },
  { id: "L10", group: "log", name: "checkpoint verifies against the pinned key" },
  { id: "M1", group: "mandate", name: "open mandate present for every record" },
  { id: "M2", group: "mandate", name: "closed mandate present for every record" },
  { id: "M3", group: "mandate", name: "open mandate verifies against pinned issuer" },
  { id: "M4", group: "mandate", name: "closed mandate verifies against endorsed agent key" },
  { id: "M5", group: "mandate", name: "parent_hash binds closed to this open mandate" },
  { id: "M6", group: "mandate", name: "subject and audience agree across the chain" },
  { id: "M7", group: "mandate", name: "closed constraints attenuate the open mandate" },
  { id: "M8", group: "mandate", name: "record hashes match the presented JWSs" },
  { id: "R1", group: "request", name: "closed.request_hash matches the bundled checkout" },
  { id: "R2", group: "request", name: "receipt derives from closed_jti and request_hash" },
  { id: "R3", group: "request", name: "tool.args.receipt matches the derived receipt" },
  { id: "T1", group: "temporal", name: "record timestamp falls inside the closed mandate" },
  { id: "T2", group: "temporal", name: "closed jti is not reused" },
  { id: "T3", group: "temporal", name: "nonce matches the one issued for the checkout" },
  { id: "B1", group: "bounds", name: "ALLOW stays within budget_max" },
  { id: "B2", group: "bounds", name: "DENY/ESCALATE carries first_deny" },
  { id: "B3", group: "bounds", name: "ALLOW has first_deny null" },
  { id: "E1", group: "external", name: "receipt is well-formed Crockford" },
  { id: "E2", group: "external", name: "receipt file agrees with the record" },
  { id: "P1", group: "policy", name: "decide() replays to the recorded decision" },
] as const;

if (CHECKS.length !== 30) {
  throw new Error(`CHECK list is ${CHECKS.length} long; the demo promises 30`);
}

export interface Finding {
  readonly check: string;
  readonly ok: boolean;
  readonly seq?: number;
  readonly detail: string;
}

export interface CheckResult {
  readonly spec: CheckSpec;
  readonly ok: boolean;
  readonly findings: readonly Finding[];
}

export interface Report {
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

export async function verifyBundle(bundle: LoadedBundle, trust: Trust): Promise<Report> {
  const findings: Finding[] = [];
  const fail = (check: string, detail: string, seq?: number): void => {
    findings.push(
      seq === undefined ? { check, ok: false, detail } : { check, ok: false, seq, detail },
    );
  };
  const pass = (check: string, detail = "ok"): void => {
    findings.push({ check, ok: true, detail });
  };

  const records = bundle.records;

  // ---- log ---------------------------------------------------------------

  if (records.length === 0) {
    fail("L1", "bundle contains no records");
  } else {
    const ordered = records.every((r, i) => i === 0 || r.seq === (records[i - 1]?.seq ?? 0) + 1);
    if (!ordered) fail("L1", "records.jsonl is not in seq order");
    else pass("L1", `${records.length} record(s)`);
  }

  const chain = verifyRecordChain(records);
  const byKind = (kind: (typeof chain)[number]["kind"], check: string, label: string): void => {
    const hits = chain.filter((v) => v.kind === kind);
    if (hits.length === 0) {
      pass(check, label);
      return;
    }
    for (const hit of hits) fail(check, hit.detail, hit.seq);
  };

  byKind("bad_record_hash", "L2", "every record_hash matches");
  byKind("broken_link", "L3", `chain starts at ${GENESIS_HASH}`);
  byKind("non_contiguous_seq", "L4", "seq is gapless");
  byKind("arithmetic_mismatch", "L5", "arithmetic holds");
  byKind("accounting_discontinuity", "L6", "no omitted spend");
  byKind("actions_discontinuity", "L7", "no omitted action");

  const latest = latestCheckpoint(bundle);
  let verifiedCheckpoint: { size: number; rootHash: Uint8Array; note: string } | undefined;

  if (latest === undefined) {
    fail("L10", "bundle contains no checkpoint");
    fail("L8", "no checkpoint to compare a Merkle root against");
    fail("L9", "no checkpoint to prove inclusion against");
  } else {
    try {
      const verified = await verifyCheckpoint(
        latest.note,
        trust.origin,
        trust.checkpointKeyName,
        trust.checkpoint,
      );
      verifiedCheckpoint = { size: verified.size, rootHash: verified.rootHash, note: latest.note };
      pass("L10", `checkpoint size ${verified.size} verifies`);

      if (verified.size !== records.length) {
        fail("L8", `checkpoint covers ${verified.size} leaves, log has ${records.length}`);
      } else {
        const computed = root(records.map((r) => utf8(r.record_hash)));
        if (hex(computed) !== hex(verified.rootHash)) {
          fail("L8", `Merkle root is ${hex(computed)}, checkpoint has ${hex(verified.rootHash)}`);
        } else {
          pass("L8", `root ${hex(computed)}`);
        }
      }
    } catch (error) {
      const message = error instanceof CheckpointError ? error.message : (error as Error).message;
      fail("L10", message);
      fail("L8", `checkpoint unusable: ${message}`);
      fail("L9", `checkpoint unusable: ${message}`);
    }
  }

  if (verifiedCheckpoint !== undefined && verifiedCheckpoint.size === records.length) {
    let inclusionFailed = 0;
    for (const record of records) {
      const leaf = leafHash(utf8(record.record_hash));
      const recomputed = inclusionProof(
        record.seq,
        records.map((r) => utf8(r.record_hash)),
      );
      if (
        !verifyInclusion(
          record.seq,
          verifiedCheckpoint.size,
          leaf,
          recomputed,
          verifiedCheckpoint.rootHash,
        )
      ) {
        inclusionFailed += 1;
        fail("L9", "inclusion proof does not verify", record.seq);
      }
    }
    if (inclusionFailed === 0) pass("L9", `proved ${records.length} leaves`);
  }

  // ---- mandates ----------------------------------------------------------

  const seenClosed = new Map<string, number>();

  for (const record of records) {
    const openJws = bundle.mandates.get(record.mandate.open_jti);
    const closedJws = bundle.mandates.get(record.mandate.closed_jti);
    const checkout = bundle.checkouts.get(record.mandate.closed_jti);

    if (openJws === undefined) {
      fail("M1", `no mandates/${record.mandate.open_jti}.jws`, record.seq);
      continue;
    }
    if (closedJws === undefined) {
      fail("M2", `no mandates/${record.mandate.closed_jti}.jws`, record.seq);
      continue;
    }

    if (hashJws(openJws) !== record.mandate.open_hash) {
      fail("M8", `record open_hash does not match the presented open JWS`, record.seq);
    }
    if (hashJws(closedJws) !== record.mandate.closed_hash) {
      fail("M8", `record closed_hash does not match the presented closed JWS`, record.seq);
    }

    if (checkout === undefined) {
      fail("R1", `no checkouts/${record.mandate.closed_jti}.json`, record.seq);
      fail("T3", `no bundled nonce for ${record.mandate.closed_jti}`, record.seq);
      continue;
    }

    const chainResult = await verifyChain(
      {
        openJws,
        closedJws,
        checkout: checkout.checkout as JsonValue,
        expectedNonce: checkout.nonce,
        audience: trust.audience,
      },
      { issuerKey: trust.issuer, now: unix(record.ts) },
    );

    if (!chainResult.ok) {
      const mapped: Record<string, string> = {
        open_signature_invalid: "M3",
        closed_signature_invalid: "M4",
        parent_binding_invalid: "M5",
        claims_disagree: "M6",
        not_attenuated: "M7",
        request_binding_invalid: "R1",
      };
      const check =
        mapped[chainResult.code] ??
        (chainResult.code === "expired" || chainResult.code === "not_yet_valid" ? "T1" : "M3");
      if (chainResult.code === "claims_disagree" && chainResult.reason.includes("nonce")) {
        fail("T3", chainResult.reason, record.seq);
      } else {
        fail(check, chainResult.reason, record.seq);
      }
      continue;
    }

    pass("M1", record.mandate.open_jti);
    pass("M2", record.mandate.closed_jti);
    pass("M3");
    pass("M4");
    pass("M5");
    pass("M6");
    pass("M7");
    pass("M8");
    pass("R1");
    pass("T3");

    const derived = deriveReceipt(record.mandate.closed_jti, chainResult.closed.request_hash);
    const toolReceipt = stringArg(record.tool.args, "receipt");

    if (toolReceipt === undefined) {
      fail("R3", "tool.args.receipt is missing", record.seq);
    } else if (toolReceipt !== derived) {
      fail("R3", `tool.args.receipt is ${toolReceipt}, derived ${derived}`, record.seq);
    } else {
      pass("R3", derived);
      pass("R2", derived);
    }

    if (!isWellFormedReceipt(derived))
      fail("E1", `derived receipt ${derived} is malformed`, record.seq);
    else pass("E1", derived);

    const ts = unix(record.ts);
    if (ts < chainResult.closed.iat || ts > chainResult.closed.exp) {
      fail(
        "T1",
        `record ts ${record.ts} is outside closed mandate [${chainResult.closed.iat}, ${chainResult.closed.exp}]`,
        record.seq,
      );
    } else {
      pass("T1");
    }

    const previous = seenClosed.get(record.mandate.closed_jti);
    if (previous !== undefined && record.decision === "ALLOW") {
      fail("T2", `closed jti reused (first seen at seq ${previous})`, record.seq);
    } else {
      seenClosed.set(record.mandate.closed_jti, record.seq);
      pass("T2");
    }

    if (record.decision === "ALLOW" && record.accounting.budget_max_paise !== null) {
      if (record.accounting.spent_after_paise > record.accounting.budget_max_paise) {
        fail(
          "B1",
          `spent_after ${record.accounting.spent_after_paise} exceeds budget_max ${record.accounting.budget_max_paise}`,
          record.seq,
        );
      } else {
        pass("B1");
      }
    }

    if (record.decision === "ALLOW") {
      if (record.policy.first_deny !== null) {
        fail("B3", `ALLOW record has first_deny ${record.policy.first_deny}`, record.seq);
      } else {
        pass("B3");
      }
    } else if (record.policy.first_deny === null) {
      fail("B2", `${record.decision} record has no first_deny`, record.seq);
    } else {
      pass("B2", record.policy.first_deny);
    }

    const receiptFile = bundle.receipts.get(derived);
    if (receiptFile === undefined) {
      fail("E2", `no receipts/${derived}.json`, record.seq);
    } else if (receiptFile.record_hash !== record.record_hash || receiptFile.seq !== record.seq) {
      fail(
        "E2",
        `receipt file seq=${receiptFile.seq} hash=${receiptFile.record_hash}, record is seq=${record.seq}`,
        record.seq,
      );
    } else {
      pass("E2");
    }

    const currency = asCurrency(record.accounting.currency);
    if (currency === undefined) {
      fail("P1", `ungoverned currency ${record.accounting.currency}`, record.seq);
    } else {
      const request = {
        amount: money(BigInt(record.accounting.amount_paise), currency),
        payee: checkout.request.payee,
        rail: checkout.request.rail,
      };
      const state: SpendState = {
        spent: money(BigInt(record.accounting.spent_before_paise), currency),
        actions: record.accounting.actions_before,
        recent: recentFor(records, record, currency),
      };
      const decision = decide(chainResult.constraints, request, state, ts);
      const expected =
        record.decision === "ALLOW" ? "permit" : record.decision === "DENY" ? "deny" : "escalate";
      if (decision.effect !== expected) {
        fail(
          "P1",
          `recorded ${record.decision}, decide() returned ${decision.effect} (${decision.decidedBy ?? "—"})`,
          record.seq,
        );
      } else {
        pass("P1", decision.decidedBy ?? "permit");
      }
    }
  }

  const seen = new Set(findings.map((f) => f.check));
  for (const spec of CHECKS) {
    if (!seen.has(spec.id)) pass(spec.id, "n/a");
  }

  return summarise(findings);
}

function summarise(findings: readonly Finding[]): Report {
  const checks = CHECKS.map((spec) => {
    const mine = findings.filter((f) => f.check === spec.id);
    const failures = mine.filter((f) => !f.ok);
    return {
      spec,
      ok: failures.length === 0 && mine.length > 0,
      findings: failures.length > 0 ? failures : mine.slice(0, 1),
    };
  });

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  return { ok: failed === 0, checks, passed, failed, total: checks.length };
}

function latestCheckpoint(bundle: LoadedBundle): { size: number; note: string } | undefined {
  let best: { size: number; note: string } | undefined;
  for (const [size, note] of bundle.checkpoints) {
    if (best === undefined || size > best.size) best = { size, note };
  }
  return best;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function unix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function asCurrency(code: string): CurrencyCode | undefined {
  return (CURRENCIES as readonly string[]).includes(code) ? (code as CurrencyCode) : undefined;
}

function recentFor(
  records: readonly AuditRecord[],
  current: AuditRecord,
  currency: CurrencyCode,
): SpendState["recent"] {
  return records
    .filter(
      (r) =>
        r.seq < current.seq &&
        r.mandate.open_jti === current.mandate.open_jti &&
        r.decision === "ALLOW",
    )
    .map((r) => ({
      at: unix(r.ts),
      amount: money(BigInt(r.accounting.amount_paise), currency),
    }));
}

export type { Checkpoint };
