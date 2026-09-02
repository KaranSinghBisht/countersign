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
  assertExtends,
  type Checkpoint,
  CheckpointError,
  verify as verifyCheckpoint,
} from "../audit/checkpoint.js";
import { leafHash, root, verifyInclusion } from "../audit/merkle.js";
import { type AuditRecord, GENESIS_HASH, verifyRecordChain } from "../audit/record.js";
import { assertCanonicalizable, type JsonValue } from "../crypto/canonical.js";
import { digestJson } from "../crypto/digest.js";
import { hex, hexDecode, utf8 } from "../crypto/encoding.js";
import { CLOCK_SKEW_SECONDS } from "../mandate/types.js";
import { type ChainSuccess, hashJws, verifyChain } from "../mandate/verify.js";
import { CURRENCIES, type CurrencyCode, money } from "../money/money.js";
import { decide, type SpendState } from "../policy/engine.js";
import { deriveReceipt, isWellFormedReceipt } from "../razorpay/receipt.js";
import {
  BoundCartSchema,
  type CheckoutFile,
  type LoadedBundle,
  type ReceiptFile,
} from "./bundle.js";
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
  /** The check never ran because an earlier one failed first. Not a failure. */
  readonly skipped?: true;
}

export interface CheckResult {
  readonly spec: CheckSpec;
  readonly ok: boolean;
  /** Never evaluated — the bundle failed before this check could run. */
  readonly skipped: boolean;
  readonly findings: readonly Finding[];
}

export interface Report {
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly passed: number;
  readonly failed: number;
  /** Checks that never ran. A report with any of these is not verified. */
  readonly skipped: number;
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

  for (const record of records) {
    try {
      assertCanonicalizable(record.tool.args);
      const actual = digestJson(record.tool.args as JsonValue);
      if (actual !== record.tool.args_sha256) {
        fail(
          "L2",
          `tool.args_sha256 is ${record.tool.args_sha256}, args hash to ${actual}`,
          record.seq,
        );
      }
    } catch {
      fail("L2", "tool.args is not canonical JSON", record.seq);
    }
  }

  const notes = [...bundle.checkpoints.entries()].sort(([a], [b]) => a - b);
  let verifiedCheckpoint: { size: number; rootHash: Uint8Array; note: string } | undefined;

  if (notes.length === 0) {
    fail("L10", "bundle contains no checkpoint");
    fail("L8", "no checkpoint to compare a Merkle root against");
    fail("L9", "no checkpoint to prove inclusion against");
  } else {
    const verified: { size: number; origin: string; rootHash: Uint8Array }[] = [];
    let notesOk = true;

    for (const [filenameSize, note] of notes) {
      try {
        const next = await verifyCheckpoint(
          note,
          trust.origin,
          trust.checkpointKeyName,
          trust.checkpoint,
        );
        if (next.size !== filenameSize) {
          notesOk = false;
          fail(
            "L10",
            `checkpoint filename size ${filenameSize} does not match note size ${next.size}`,
          );
          continue;
        }
        const previous = verified[verified.length - 1];
        if (previous !== undefined) {
          assertExtends(previous, next, new Date(previous.size), new Date(next.size));
        }
        verified.push(next);
      } catch (error) {
        notesOk = false;
        const message = error instanceof CheckpointError ? error.message : (error as Error).message;
        fail("L10", message);
      }
    }

    const latest = verified[verified.length - 1];
    if (notesOk && latest !== undefined) {
      pass("L10", `checkpoint size ${latest.size} verifies (${verified.length} note(s))`);
      verifiedCheckpoint = {
        size: latest.size,
        rootHash: latest.rootHash,
        note: notes.at(-1)?.[1] ?? "",
      };

      let rootsOk = true;
      for (const cp of verified) {
        if (cp.size > records.length) {
          rootsOk = false;
          fail("L8", `checkpoint covers ${cp.size} leaves, log has ${records.length}`);
          continue;
        }
        const computed = root(records.slice(0, cp.size).map((r) => utf8(r.record_hash)));
        if (hex(computed) !== hex(cp.rootHash)) {
          rootsOk = false;
          fail(
            "L8",
            `Merkle root at size ${cp.size} is ${hex(computed)}, checkpoint has ${hex(cp.rootHash)}`,
          );
        }
      }
      if (latest.size !== records.length) {
        rootsOk = false;
        fail("L8", `latest checkpoint covers ${latest.size} leaves, log has ${records.length}`);
      }
      if (rootsOk) pass("L8", `root ${hex(latest.rootHash)}`);
    } else {
      fail("L8", "checkpoint unusable: a note did not verify or does not extend");
      fail("L9", "checkpoint unusable: a note did not verify or does not extend");
    }
  }

  if (verifiedCheckpoint !== undefined && verifiedCheckpoint.size === records.length) {
    const receiptsBySeq = new Map<number, ReceiptFile>();
    for (const r of bundle.receipts.values()) {
      if (!receiptsBySeq.has(r.seq)) receiptsBySeq.set(r.seq, r);
    }

    let inclusionFailed = 0;
    let proved = 0;
    for (const record of records) {
      const leaf = leafHash(utf8(record.record_hash));
      const receipt = receiptsBySeq.get(record.seq);
      if (receipt === undefined) {
        // Receipts exist only for permitted purchases — a refusal never
        // reaches Razorpay, so it has nothing to hold a receipt for. Its
        // inclusion is already established by L8, which recomputed the
        // full Merkle root from every record including this one.
        if (record.decision !== "ALLOW") continue;
        inclusionFailed += 1;
        fail("L9", "no inclusion proof in receipts/", record.seq);
        continue;
      }
      if (receipt.record_hash !== record.record_hash) {
        inclusionFailed += 1;
        fail("L9", "receipt record_hash does not match the log", record.seq);
        continue;
      }
      if (receipt.tree_size !== verifiedCheckpoint.size) {
        inclusionFailed += 1;
        fail(
          "L9",
          `receipt proof is for tree_size ${receipt.tree_size}, checkpoint is ${verifiedCheckpoint.size}`,
          record.seq,
        );
        continue;
      }
      let proof: Uint8Array[];
      try {
        proof = receipt.proof.map(hexDecode);
      } catch {
        inclusionFailed += 1;
        fail("L9", "receipt proof is not hex", record.seq);
        continue;
      }
      if (
        !verifyInclusion(
          record.seq,
          verifiedCheckpoint.size,
          leaf,
          proof,
          verifiedCheckpoint.rootHash,
        )
      ) {
        inclusionFailed += 1;
        fail("L9", "inclusion proof in receipts/ does not verify", record.seq);
      } else {
        proved += 1;
      }
    }
    if (inclusionFailed === 0) {
      pass(
        "L9",
        proved > 0
          ? `proved ${proved} ALLOW leaf(s) from receipts/; refusals covered by the L8 root`
          : "no ALLOW records; inclusion established by the L8 root recomputation",
      );
    }
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
      fail("R2", "tool.args.receipt is missing", record.seq);
    } else if (toolReceipt !== derived) {
      fail("R3", `tool.args.receipt is ${toolReceipt}, derived ${derived}`, record.seq);
      fail("R2", `tool.args.receipt is ${toolReceipt}, derived ${derived}`, record.seq);
    } else {
      pass("R3", derived);
      pass("R2", derived);
    }

    if (!isWellFormedReceipt(derived))
      fail("E1", `derived receipt ${derived} is malformed`, record.seq);
    else pass("E1", derived);

    // The same tolerance the server applied when it accepted the mandate
    // (verifyChain: `now + skew < iat` / `now - skew >= exp`). A stricter
    // window here would make the verifier reject purchases the server
    // honestly admitted 20 seconds inside the skew — a verifier that
    // disagrees with the code it imports is not replaying the decision.
    const ts = unix(record.ts);
    if (
      ts + CLOCK_SKEW_SECONDS < chainResult.closed.iat ||
      ts - CLOCK_SKEW_SECONDS >= chainResult.closed.exp
    ) {
      fail(
        "T1",
        `record ts ${record.ts} is outside closed mandate [${chainResult.closed.iat}, ${chainResult.closed.exp}] beyond the ${CLOCK_SKEW_SECONDS}s skew`,
        record.seq,
      );
    } else {
      pass("T1");
    }

    const previous = seenClosed.get(record.mandate.closed_jti);
    if (previous !== undefined) {
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
      // A refusal never created a payment, so no receipt file can exist for
      // it. Only a permitted purchase is required to carry one.
      if (record.decision === "ALLOW") {
        fail("E2", `no receipts/${derived}.json`, record.seq);
      } else {
        pass("E2", "refusal carries no receipt file, by design");
      }
    } else if (receiptFile.record_hash !== record.record_hash || receiptFile.seq !== record.seq) {
      fail(
        "E2",
        `receipt file seq=${receiptFile.seq} hash=${receiptFile.record_hash}, record is seq=${record.seq}`,
        record.seq,
      );
    } else if (receiptFile.receipt !== derived) {
      fail("E2", `receipt file name is ${receiptFile.receipt}, derived ${derived}`, record.seq);
    } else if (receiptFile.amount_paise !== record.accounting.amount_paise) {
      fail(
        "E2",
        `receipt amount ${receiptFile.amount_paise} ≠ record ${record.accounting.amount_paise}`,
        record.seq,
      );
    } else {
      pass("E2");
    }

    const currency = asCurrency(record.accounting.currency);
    if (currency === undefined) {
      fail("P1", `ungoverned currency ${record.accounting.currency}`, record.seq);
    } else {
      replayPolicy(record, checkout, chainResult, currency, records, ts, pass, fail);
    }
  }

  vacuousBounds(records, findings, pass);
  const seen = new Set(findings.map((f) => f.check));
  // A chain that broke early leaves later checks unrun. Reporting those as
  // FAIL made a single bad signature read as nineteen failures; they are
  // recorded as skipped so the one real failure is what the reader sees.
  for (const spec of CHECKS) {
    if (!seen.has(spec.id)) {
      findings.push({
        check: spec.id,
        ok: false,
        skipped: true,
        detail: "not evaluated — an earlier check failed first",
      });
    }
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
      skipped: mine.length > 0 && mine.every((f) => f.skipped === true),
      findings: failures.length > 0 ? failures : mine.slice(0, 1),
    };
  });

  const passed = checks.filter((c) => c.ok).length;
  const skipped = checks.filter((c) => c.skipped).length;
  const failed = checks.filter((c) => !c.ok && !c.skipped).length;
  return {
    ok: failed === 0 && skipped === 0,
    checks,
    passed,
    failed,
    skipped,
    total: checks.length,
  };
}

function replayPolicy(
  record: AuditRecord,
  checkout: CheckoutFile,
  chainResult: ChainSuccess,
  currency: CurrencyCode,
  records: readonly AuditRecord[],
  ts: number,
  pass: (check: string, detail?: string) => void,
  fail: (check: string, detail: string, seq?: number) => void,
): void {
  const parsed = BoundCartSchema.safeParse(checkout.checkout);
  if (!parsed.success) {
    fail("P1", "checkout.checkout is not a cart with total_paise", record.seq);
    return;
  }
  const bound = parsed.data;
  const closedAmount = chainResult.closed.amount.amount;
  const closedPayee = chainResult.closed.payee.id;

  if (bound.total_paise !== record.accounting.amount_paise) {
    fail(
      "P1",
      `record amount ${record.accounting.amount_paise} ≠ hash-bound cart ${bound.total_paise}`,
      record.seq,
    );
    return;
  }
  if (closedAmount !== BigInt(bound.total_paise)) {
    fail("P1", `closed.amount ${closedAmount} ≠ hash-bound cart ${bound.total_paise}`, record.seq);
    return;
  }
  if (checkout.request.amount_paise !== bound.total_paise) {
    fail(
      "P1",
      `checkout.request.amount ${checkout.request.amount_paise} ≠ hash-bound cart ${bound.total_paise}`,
      record.seq,
    );
    return;
  }
  if (checkout.request.payee.id !== closedPayee) {
    fail(
      "P1",
      `checkout.request.payee ${checkout.request.payee.id} ≠ closed ${closedPayee}`,
      record.seq,
    );
    return;
  }
  if (bound.payee !== undefined && bound.payee.id !== closedPayee) {
    fail("P1", `cart payee ${bound.payee.id} ≠ closed ${closedPayee}`, record.seq);
    return;
  }

  const request = {
    amount: money(BigInt(bound.total_paise), currency),
    payee: { id: closedPayee },
    rail: checkout.request.rail,
    ...(bound.category !== undefined ? { category: bound.category } : {}),
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
    return;
  }

  // The verdict alone is not the evidence — "every money action explainable"
  // means the explanation is bound too. An operator holding the checkpoint
  // key could otherwise re-narrate a record (a different rule list, a kinder
  // reason) without moving the amount or the effect, and the log would still
  // verify. Rules, first_deny and reason must all replay byte-for-byte.
  const recordedRules = record.policy.rules_evaluated.map((r) => `${r.id}:${r.effect}`).join(",");
  const replayedRules = decision.rules.map((r) => `${r.id}:${r.effect}`).join(",");
  if (recordedRules !== replayedRules) {
    fail(
      "P1",
      `rules_evaluated [${recordedRules || "none"}] ≠ replay [${replayedRules}]`,
      record.seq,
    );
    return;
  }
  if (record.policy.first_deny !== decision.decidedBy) {
    fail(
      "P1",
      `first_deny ${record.policy.first_deny ?? "null"} ≠ replay ${decision.decidedBy ?? "null"}`,
      record.seq,
    );
    return;
  }
  if (record.reason !== decision.reason) {
    fail("P1", `reason "${record.reason}" ≠ replay "${decision.reason}"`, record.seq);
    return;
  }
  pass("P1", decision.decidedBy ?? "permit");
}

function vacuousBounds(
  records: readonly AuditRecord[],
  findings: readonly Finding[],
  pass: (check: string, detail?: string) => void,
): void {
  const seen = new Set(findings.map((f) => f.check));
  const hasAllowBudget = records.some(
    (r) => r.decision === "ALLOW" && r.accounting.budget_max_paise !== null,
  );
  const hasRefusal = records.some((r) => r.decision === "DENY" || r.decision === "ESCALATE");
  const hasAllow = records.some((r) => r.decision === "ALLOW");

  if (!seen.has("B1") && !hasAllowBudget) pass("B1", "no ALLOW with a budget");
  if (!seen.has("B2") && !hasRefusal) pass("B2", "no DENY/ESCALATE records");
  if (!seen.has("B3") && !hasAllow) pass("B3", "no ALLOW records");
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
