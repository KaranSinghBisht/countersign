/**
 * Export a verifiable bundle from the LIVE database.
 *
 * This is the difference between "we have an audit log" and "here is the
 * evidence": everything below comes from rows real purchases committed —
 * records, checkpoint notes, the exact mandate JWSes and checkouts — and the
 * resulting directory verifies with the offline CLI against out-of-band
 * trust, exactly like the rehearsed demo bundle.
 *
 * Only the SEALED prefix is exported: records up to the latest published
 * checkpoint. Records past the checkpoint exist but nobody has committed to
 * them yet, and a bundle whose records outrun its signed root cannot verify.
 */

import type { JsonValue } from "../crypto/canonical.js";
import { canonicalBytes } from "../crypto/canonical.js";
import { digestB64u } from "../crypto/digest.js";
import { hex } from "../crypto/encoding.js";
import type { Sql, TransactionSql } from "../db/client.js";
import { deriveReceipt } from "../razorpay/receipt.js";
import type { CheckoutFile, ReceiptFile } from "../verify/bundle.js";
import { writeBundle } from "../verify/export.js";
import { allCheckpoints, latestCheckpoint, proveInclusionMany, read } from "./log.js";
import type { AuditRecord } from "./record.js";

export interface LiveExportResult {
  readonly dir: string;
  readonly records: number;
  readonly treeSize: number;
}

/**
 * The export reads inside ONE repeatable-read transaction. A bundle is a
 * statement about a single state of the log; assembled from a sequence of
 * independent reads while a purchase commits, it could carry a checkpoint
 * from one generation and a record from the next, and verify against neither.
 */
export async function exportLiveBundle(sql: Sql, dir: string): Promise<LiveExportResult> {
  return sql.begin("isolation level repeatable read read only", (tx) => exportWithin(tx, dir));
}

async function exportWithin(sql: TransactionSql, dir: string): Promise<LiveExportResult> {
  const latest = await latestCheckpoint(sql);
  if (latest === undefined) {
    throw new Error(
      "no checkpoint published yet; nothing is sealed. " +
        "The worker publishes one shortly after the first purchase.",
    );
  }

  const treeSize = latest.checkpoint.size;
  const records = await read(sql, 0, treeSize);
  if (records.length !== treeSize) {
    throw new Error(`checkpoint covers ${treeSize} records but the log holds ${records.length}`);
  }

  const checkpoints: Record<number, string> = {};
  for (const cp of await allCheckpoints(sql)) {
    // A note past the sealed prefix would make the bundle's own consistency
    // chain (L10/L8) refer to records the bundle does not contain.
    if (cp.size <= treeSize) checkpoints[cp.size] = cp.note;
  }

  const mandates: Record<string, string> = {};
  const checkouts: Record<string, CheckoutFile> = {};
  const receipts: Record<string, ReceiptFile> = {};

  // Every proof from one read of the leaves — not one full read per record.
  const evidenceBySeq = await proveInclusionMany(
    sql,
    records.filter((r) => r.decision === "ALLOW").map((r) => r.seq),
    treeSize,
  );

  for (const record of records) {
    const artifact = (
      await sql<
        {
          open_jti: string;
          open_jws: string;
          closed_jws: string;
          nonce: string;
          checkout: JsonValue;
          request: CheckoutFile["request"];
        }[]
      >`
				SELECT open_jti, open_jws, closed_jws, nonce, checkout, request
				  FROM mandate_artifacts
				 WHERE closed_jti = ${record.mandate.closed_jti}
			`
    )[0];
    if (artifact === undefined) {
      throw new Error(
        `no stored mandate artifacts for ${record.mandate.closed_jti}; ` +
          "records written before artifact storage existed cannot be exported verifiably",
      );
    }

    mandates[record.mandate.open_jti] = artifact.open_jws;
    mandates[record.mandate.closed_jti] = artifact.closed_jws;
    checkouts[record.mandate.closed_jti] = {
      nonce: artifact.nonce,
      checkout: artifact.checkout,
      request: artifact.request,
    };

    // Receipts exist only for permitted purchases; a refusal never reached
    // Razorpay. The verifier's L9/E2 expect exactly that.
    if (record.decision !== "ALLOW") continue;

    const requestHash = digestB64u(canonicalBytes(artifact.checkout));
    const receipt = deriveReceipt(record.mandate.closed_jti, requestHash);
    const payment = (
      await sql<
        { order_id: string | null; payment_id: string | null; signature_verified: boolean }[]
      >`
				SELECT order_id, payment_id, signature_verified FROM payments WHERE receipt = ${receipt}
			`
    )[0];

    const evidence = evidenceBySeq.get(record.seq);
    if (evidence === undefined) throw new Error(`no inclusion evidence for seq ${record.seq}`);
    receipts[receipt] = {
      receipt,
      closed_jti: record.mandate.closed_jti,
      request_hash: requestHash,
      order_id: payment?.order_id ?? null,
      payment_id: payment?.payment_id ?? null,
      signature_verified: payment?.signature_verified ?? false,
      amount_paise: record.accounting.amount_paise,
      currency: record.accounting.currency,
      seq: record.seq,
      record_hash: record.record_hash,
      tree_size: treeSize,
      leaf_hash: hex(evidence.leafHash),
      root: hex(evidence.root),
      proof: evidence.proof.map(hex),
      checkpoint_note: latest.note,
      record,
    };
  }

  writeBundle(dir, {
    records,
    checkpoints,
    mandates,
    checkouts,
    receipts,
    ...(policyOf(records) ?? {}),
  });

  return { dir, records: records.length, treeSize };
}

/**
 * The optional policy file is only honest when every record was decided by
 * the same engine against the same bundle; otherwise it is omitted and the
 * per-record policy blocks remain the source of truth.
 */
function policyOf(
  records: readonly AuditRecord[],
): { policy: { engine_version: string; bundle_sha256: string } } | undefined {
  const first = records[0];
  if (first === undefined) return undefined;
  const uniform = records.every(
    (r) =>
      r.policy.engine_version === first.policy.engine_version &&
      r.policy.bundle_sha256 === first.policy.bundle_sha256,
  );
  if (!uniform) return undefined;
  return {
    policy: {
      engine_version: first.policy.engine_version,
      bundle_sha256: first.policy.bundle_sha256,
    },
  };
}
