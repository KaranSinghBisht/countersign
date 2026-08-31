/**
 * `countersign explain --bundle <b> (--seq <n> | --receipt <r> | --closed <jti> | --order <id>)`
 *
 * "Every money action explainable" as a literal command. Reads the bundle and
 * narrates what happened, in order, without asking the operator to reconstruct
 * it from JSON.
 *
 * The primary selectors are the ones a live record actually carries: its
 * `seq` (which every `/purchase` response returns), its derived receipt, and
 * its closed mandate. A Razorpay `order_id` is only known after the worker
 * has talked to Razorpay, and audit records are immutable once appended, so
 * a live record never carries one. `--order` therefore goes through the
 * bundle's receipt files, which the export writes once the order exists and
 * which E2 binds to their records — the same path a settlement dispute
 * would take from a Razorpay dashboard back to the decision.
 */

import type { AuditRecord } from "../audit/record.js";
import { CURRENCIES, type CurrencyCode, format, money } from "../money/money.js";
import type { LoadedBundle } from "./bundle.js";

export type ExplainSelector =
  | { readonly seq: number }
  | { readonly receipt: string }
  | { readonly closedJti: string }
  | { readonly order: string };

function matches(record: AuditRecord, selector: ExplainSelector, bundle: LoadedBundle): boolean {
  if ("seq" in selector) return record.seq === selector.seq;
  if ("receipt" in selector) {
    const args = record.tool.args as { readonly receipt?: unknown };
    return args.receipt === selector.receipt;
  }
  if ("closedJti" in selector) return record.mandate.closed_jti === selector.closedJti;
  if (record.external?.order_id === selector.order) return true;
  for (const receipt of bundle.receipts.values()) {
    if (receipt.order_id === selector.order && receipt.closed_jti === record.mandate.closed_jti) {
      return true;
    }
  }
  return false;
}

function describe(selector: ExplainSelector): string {
  if ("seq" in selector) return `seq ${selector.seq}`;
  if ("receipt" in selector) return `receipt ${selector.receipt}`;
  if ("closedJti" in selector) return `closed mandate ${selector.closedJti}`;
  return `order ${selector.order}`;
}

export function explain(bundle: LoadedBundle, selector: ExplainSelector): string | undefined {
  const records = bundle.records.filter((r) => matches(r, selector, bundle));
  if (records.length === 0) return undefined;

  const lines: string[] = [describe(selector), `${records.length} record(s)`, ""];

  for (const record of records) {
    const currency = asCurrency(record.accounting.currency);
    const amount =
      currency === undefined
        ? `${record.accounting.amount_paise} ${record.accounting.currency}`
        : format(money(BigInt(record.accounting.amount_paise), currency));
    const before =
      currency === undefined
        ? String(record.accounting.spent_before_paise)
        : format(money(BigInt(record.accounting.spent_before_paise), currency));
    const after =
      currency === undefined
        ? String(record.accounting.spent_after_paise)
        : format(money(BigInt(record.accounting.spent_after_paise), currency));

    lines.push(`seq ${record.seq}  ${record.ts}  ${record.decision}`);
    lines.push(`  ${record.reason}`);
    lines.push(`  ${record.tool.name}  ${amount}`);
    lines.push(`  spent ${before} + ${amount} → ${after}`);
    if (record.policy.first_deny !== null) {
      lines.push(`  first_deny ${record.policy.first_deny}`);
    }
    if (record.external !== null) {
      lines.push(
        `  rail ${record.external.rail}  status ${record.external.status}` +
          (record.external.payment_id === null ? "" : `  ${record.external.payment_id}`),
      );
    }
    lines.push(`  mandate ${record.mandate.open_jti} → ${record.mandate.closed_jti}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Kept for callers that only know an order id. */
export function explainOrder(bundle: LoadedBundle, orderId: string): string | undefined {
  return explain(bundle, { order: orderId });
}

function asCurrency(code: string): CurrencyCode | undefined {
  return (CURRENCIES as readonly string[]).includes(code) ? (code as CurrencyCode) : undefined;
}
