/**
 * Posting to the double-entry ledger.
 *
 * An authorization hold is not a special case here. It is an ordinary balanced
 * transaction moving value into a dedicated holding account, and capture is
 * another ordinary transaction moving it out. That keeps the schema strictly
 * append-only with no status column to update, and it means "what is currently
 * held" is answerable by summing an account rather than by trusting a flag.
 *
 * `expense:psp_fees` exists from the start. A ledger that models the gross
 * amount but not the fee reconciles against the settlement report only by
 * accident, and the discrepancy shows up on the day someone first compares the
 * two.
 */

import type { Sql, TransactionSql } from "../db/client.js";
import { type CurrencyCode, type Money, money } from "../money/money.js";

export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "expense";
export type TransactionKind = "hold" | "capture" | "release" | "fee" | "refund";

export interface Posting {
  readonly account: string;
  /** Signed minor units. Debits positive, credits negative. */
  readonly amount: Money;
}

export interface PostInput {
  /** ULID, supplied by the caller so the ledger stays free of clocks and RNG. */
  readonly id: string;
  readonly kind: TransactionKind;
  readonly memo: string;
  readonly postings: readonly Posting[];
  readonly openJti?: string;
  readonly closedJti?: string;
  readonly externalRef?: string;
}

export class LedgerError extends Error {}

/**
 * The chart of accounts.
 *
 * Named rather than free-form, because a typo in an account id would otherwise
 * create a new account silently and the money would balance into a place
 * nobody looks at.
 */
export const ACCOUNTS: readonly { id: string; kind: AccountKind }[] = [
  // What the merchant has a claim on once a payment settles.
  { id: "asset:razorpay_receivable", kind: "asset" },
  // Value authorised but not yet captured. Holds live here and nowhere else.
  { id: "asset:authorization_holds", kind: "asset" },
  // What the buyer owes us before authorisation.
  { id: "asset:buyer_receivable", kind: "asset" },
  { id: "revenue:sales", kind: "revenue" },
  // Modelled explicitly. Gross-only ledgers do not reconcile.
  { id: "expense:psp_fees", kind: "expense" },
];

export async function ensureAccounts(sql: Sql, currency: CurrencyCode): Promise<void> {
  for (const account of ACCOUNTS) {
    await sql`
			INSERT INTO ledger_accounts (id, kind, currency)
			VALUES (${account.id}, ${account.kind}, ${currency})
			ON CONFLICT (id, currency) DO NOTHING
		`;
  }
}

/**
 * Post a balanced transaction.
 *
 * Balance is asserted here AND enforced by a deferred constraint trigger in
 * the database. The duplication is deliberate: this check produces a useful
 * error naming the offending currency and total, while the trigger is what
 * makes the guarantee true for every writer, including a psql session.
 */
export async function post(sql: Sql | TransactionSql, input: PostInput): Promise<void> {
  if (input.postings.length < 2) {
    throw new LedgerError(
      `transaction ${input.id} has ${input.postings.length} posting(s); ` +
        `double-entry requires at least two`,
    );
  }

  assertBalanced(input);

  const run = async (tx: TransactionSql): Promise<void> => {
    await tx`
			INSERT INTO ledger_transactions (id, kind, memo, open_jti, closed_jti, external_ref)
			VALUES (
				${input.id}, ${input.kind}, ${input.memo},
				${input.openJti ?? null}, ${input.closedJti ?? null}, ${input.externalRef ?? null}
			)
		`;

    for (const posting of input.postings) {
      await tx`
				INSERT INTO ledger_entries (transaction_id, account_id, currency, amount_minor)
				VALUES (${input.id}, ${posting.account}, ${posting.amount.currency}, ${posting.amount.amount})
			`;
    }
  };

  await atomically(sql, run);
}

/**
 * Run `fn` atomically, whether the caller gave us a pool or a live transaction.
 *
 * A pool gets a transaction; a transaction gets a SAVEPOINT. This matters
 * because spend accounting, the replay guard and the audit record must commit
 * atomically with the posting — the ledger must never quietly commit
 * underneath a caller that is still deciding whether to.
 *
 * The two cases are distinguished by capability rather than by a flag: only a
 * transaction exposes `savepoint`, and only a pool exposes `begin`.
 */
async function atomically(
  sql: Sql | TransactionSql,
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  if ("savepoint" in sql) {
    await sql.savepoint(fn);
    return;
  }
  await sql.begin(fn);
}

function assertBalanced(input: PostInput): void {
  const totals = new Map<CurrencyCode, bigint>();

  for (const posting of input.postings) {
    const current = totals.get(posting.amount.currency) ?? 0n;
    totals.set(posting.amount.currency, current + posting.amount.amount);
  }

  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new LedgerError(
        `transaction ${input.id} does not balance in ${currency}: postings sum to ${total}`,
      );
    }
  }
}

export interface Balance {
  readonly account: string;
  readonly kind: AccountKind;
  readonly balance: Money;
  readonly entryCount: number;
}

export async function balances(sql: Sql, currency: CurrencyCode): Promise<Balance[]> {
  const rows = await sql<
    { account_id: string; kind: AccountKind; balance_minor: bigint; entry_count: bigint }[]
  >`
		SELECT account_id, kind, balance_minor, entry_count
		FROM ledger_balances
		WHERE currency = ${currency}
		ORDER BY account_id
	`;

  return rows.map((r) => ({
    account: r.account_id,
    kind: r.kind,
    balance: money(r.balance_minor, currency),
    entryCount: Number(r.entry_count),
  }));
}

export async function balanceOf(sql: Sql, account: string, currency: CurrencyCode): Promise<Money> {
  const [row] = await sql<{ balance_minor: bigint }[]>`
		SELECT balance_minor FROM ledger_balances
		WHERE account_id = ${account} AND currency = ${currency}
	`;

  if (row === undefined) throw new LedgerError(`no such account: ${account} (${currency})`);
  return money(row.balance_minor, currency);
}

/**
 * The ledger's own health check: every currency must sum to zero across all
 * accounts.
 *
 * If this is ever non-zero, either an entry was posted outside `post` or the
 * constraint trigger is not installed. Cheap to run, and it fails loudly
 * rather than letting an imbalance sit undetected until reconciliation.
 */
export async function isInBalance(
  sql: Sql,
): Promise<{ ok: boolean; totals: Record<string, string> }> {
  const rows = await sql<{ currency: CurrencyCode; total: bigint }[]>`
		SELECT currency, COALESCE(SUM(amount_minor), 0)::BIGINT AS total
		FROM ledger_entries
		GROUP BY currency
	`;

  const totals: Record<string, string> = {};
  let ok = true;

  for (const row of rows) {
    totals[row.currency] = row.total.toString();
    if (row.total !== 0n) ok = false;
  }

  return { ok, totals };
}

/** A hold: value moves from the buyer's receivable into the holding account. */
export const holdPostings = (amount: Money): Posting[] => [
  { account: "asset:authorization_holds", amount },
  { account: "asset:buyer_receivable", amount: negated(amount) },
];

/**
 * A capture: the hold is released and recognised as a receivable from the PSP
 * plus revenue, with the processing fee expensed.
 *
 * Four legs rather than two, because the gross amount and the fee are
 * different facts. The receivable is what Razorpay will actually settle.
 */
export const capturePostings = (amount: Money, fee: Money): Posting[] => [
  { account: "asset:authorization_holds", amount: negated(amount) },
  {
    account: "asset:razorpay_receivable",
    amount: money(amount.amount - fee.amount, amount.currency),
  },
  { account: "expense:psp_fees", amount: fee },
  { account: "revenue:sales", amount: negated(amount) },
  { account: "asset:buyer_receivable", amount },
];

/** A release: the hold is undone and the buyer's receivable restored. */
export const releasePostings = (amount: Money): Posting[] => [
  { account: "asset:authorization_holds", amount: negated(amount) },
  { account: "asset:buyer_receivable", amount },
];

const negated = (m: Money): Money => money(-m.amount, m.currency);
