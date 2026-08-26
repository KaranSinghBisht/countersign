/**
 * Standalone receipt verification.
 *
 * A counterparty holds a receipt, not the log. This checks that the receipt
 * was derived from the mandate it names, that its inclusion proof lands in
 * the signed checkpoint, and that the checkpoint verifies against a key the
 * caller already trusts — never a key printed on the receipt.
 */

import { readFileSync } from "node:fs";
import { verify as verifyCheckpoint } from "../audit/checkpoint.js";
import { leafHash, verifyInclusion } from "../audit/merkle.js";
import { hashRecord } from "../audit/record.js";
import { hexDecode, utf8 } from "../crypto/encoding.js";
import { deriveReceipt, isWellFormedReceipt } from "../razorpay/receipt.js";
import { ReceiptSchema } from "./bundle.js";
import type { Trust } from "./trust.js";

export interface ReceiptReport {
  readonly ok: boolean;
  readonly findings: readonly { readonly ok: boolean; readonly detail: string }[];
}

export async function verifyReceiptFile(path: string, trust: Trust): Promise<ReceiptReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      findings: [{ ok: false, detail: `cannot read receipt: ${(error as Error).message}` }],
    };
  }

  const receipt = ReceiptSchema.safeParse(parsed);
  if (!receipt.success) {
    return {
      ok: false,
      findings: [
        {
          ok: false,
          detail: `malformed receipt: ${receipt.error.issues[0]?.message ?? "invalid"}`,
        },
      ],
    };
  }

  const r = receipt.data;
  const findings: { ok: boolean; detail: string }[] = [];

  const derived = deriveReceipt(r.closed_jti, r.request_hash);
  if (derived !== r.receipt) {
    findings.push({
      ok: false,
      detail: `receipt is ${r.receipt}, derivation from closed_jti ‖ request_hash is ${derived}`,
    });
  } else if (!isWellFormedReceipt(r.receipt)) {
    findings.push({ ok: false, detail: "receipt is not well-formed Crockford" });
  } else {
    findings.push({ ok: true, detail: "receipt derives from the mandate and request" });
  }

  if (hashRecord(r.record) !== r.record_hash || r.record.record_hash !== r.record_hash) {
    findings.push({
      ok: false,
      detail: "embedded record does not hash to record_hash",
    });
  } else if (r.record.accounting.amount_paise !== r.amount_paise) {
    findings.push({
      ok: false,
      detail: `amount_paise ${r.amount_paise} ≠ record ${r.record.accounting.amount_paise}`,
    });
  } else if (r.record.accounting.currency !== r.currency) {
    findings.push({
      ok: false,
      detail: `currency ${r.currency} ≠ record ${r.record.accounting.currency}`,
    });
  } else if ((r.record.external?.order_id ?? null) !== r.order_id) {
    findings.push({
      ok: false,
      detail: `order_id ${r.order_id} ≠ record ${r.record.external?.order_id ?? "null"}`,
    });
  } else if ((r.record.external?.payment_id ?? null) !== r.payment_id) {
    findings.push({
      ok: false,
      detail: `payment_id ${r.payment_id} ≠ record ${r.record.external?.payment_id ?? "null"}`,
    });
  } else {
    findings.push({ ok: true, detail: "display fields match the sealed record" });
  }

  try {
    const checkpoint = await verifyCheckpoint(
      r.checkpoint_note,
      trust.origin,
      trust.checkpointKeyName,
      trust.checkpoint,
    );

    if (checkpoint.size !== r.tree_size) {
      findings.push({
        ok: false,
        detail: `receipt tree_size is ${r.tree_size}, checkpoint is ${checkpoint.size}`,
      });
    }

    const included = verifyInclusion(
      r.seq,
      checkpoint.size,
      leafHash(utf8(r.record_hash)),
      r.proof.map(hexDecode),
      checkpoint.rootHash,
    );

    if (!included) {
      findings.push({
        ok: false,
        detail: `inclusion proof for seq ${r.seq} does not verify against the pinned checkpoint`,
      });
    } else {
      findings.push({
        ok: true,
        detail: `seq ${r.seq} is in the signed tree of size ${checkpoint.size}`,
      });
    }
  } catch (error) {
    findings.push({
      ok: false,
      detail: `checkpoint does not verify against the pinned key: ${(error as Error).message}`,
    });
  }

  return { ok: findings.every((f) => f.ok), findings };
}
