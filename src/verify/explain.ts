/**
 * `countersign explain --order <id>`
 *
 * "Every money action explainable" as a literal command. Reads the bundle and
 * narrates what happened, in order, without asking the operator to reconstruct
 * it from JSON.
 */

import { CURRENCIES, type CurrencyCode, format, money } from "../money/money.js";
import type { LoadedBundle } from "./bundle.js";

export function explainOrder(bundle: LoadedBundle, orderId: string): string | undefined {
  const records = bundle.records.filter((r) => r.external?.order_id === orderId);
  if (records.length === 0) return undefined;

  const lines: string[] = [`order ${orderId}`, `${records.length} record(s)`, ""];

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

function asCurrency(code: string): CurrencyCode | undefined {
  return (CURRENCIES as readonly string[]).includes(code) ? (code as CurrencyCode) : undefined;
}
