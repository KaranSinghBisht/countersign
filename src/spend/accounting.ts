/**
 * Spend accounting.
 *
 * One transaction does all of it: take the per-mandate lock, insert the replay
 * guard, read the current spend, decide, and — only if permitted — increment
 * the spend, record the action, open the authorization and post the hold.
 *
 * The atomicity is not tidiness. If the audit record can commit while the
 * spend increment fails, or the reverse, then replaying the log no longer
 * reproduces the balance, and the whole verifiability claim collapses. Either
 * all of it happened or none of it did.
 *
 * The serialization point is a `SELECT ... FOR UPDATE` on the mandate's spend
 * row. Twenty concurrent requests against a budget with room for three must
 * produce exactly three successes, and they do because nineteen of them wait
 * on that lock and re-read the balance after the winner commits. Reading the
 * balance outside a lock and then checking it is the textbook version of this
 * bug: every request sees the same "before" and every request concludes there
 * is room.
 */

import { isUniqueViolation, type Sql, type TransactionSql, withTxn } from "../db/client.js";
import { holdPostings, post } from "../ledger/ledger.js";
import type { Constraint } from "../mandate/constraints.js";
import { type CurrencyCode, type Money, money } from "../money/money.js";
import { type Decision, decide, type PurchaseRequest, type SpendState } from "../policy/engine.js";

export interface AttemptInput {
  readonly openJti: string;
  readonly closedJti: string;
  readonly constraints: readonly Constraint[];
  readonly request: PurchaseRequest;
  /** Seconds since the epoch. Injected, so the decision stays reproducible. */
  readonly now: number;
  /** ULID for the ledger transaction and the authorization. */
  readonly authorizationId: string;
  /**
   * Record the authorization as already captured rather than outstanding.
   *
   * For a synchronous rail there is no window between authorising and
   * capturing, so there is no outstanding hold — and AP2's one-in-flight rule
   * therefore does not bind, because nothing is in flight. The partial unique
   * index only covers state='authorized', so this is enforced by the same
   * index rather than by a second code path.
   */
  readonly captureImmediately?: boolean;
  /**
   * Runs inside the SAME transaction, after the spend is committed to but
   * before it lands. The audit record hooks in here so it cannot commit
   * independently of the accounting it describes.
   */
  readonly onDecision?: (tx: TransactionSql, outcome: Accounting) => Promise<void>;
  /**
   * A human has already approved this purchase. Escalation-threshold
   * constraints are dropped so `decide()` can permit; every other bound
   * still applies. Resume path without a separate ACP challenge.
   *
   * MUST be set only by an authenticated approval surface. The escalation
   * threshold is a SIGNED constraint; a flag an unauthenticated caller can
   * flip is a bypass, which is why no HTTP route plumbs this today.
   */
  readonly humanApproved?: boolean;
}

/**
 * The three integers that make record omission detectable.
 *
 * A tampered log that drops a record leaves a visible discontinuity: the next
 * record's `spentBefore` will not equal the previous record's `spentAfter`.
 * Neither AP2 nor Verifiable Intent commits the running total into the
 * evidence, which is why an omission there is undetectable.
 */
export interface Accounting {
  readonly decision: Decision;
  readonly spentBefore: Money;
  readonly amount: Money;
  readonly spentAfter: Money;
  readonly actionsBefore: number;
  readonly actionsAfter: number;
}

export type AttemptResult =
  | ({ readonly outcome: "permitted"; readonly authorizationId: string } & Accounting)
  | ({ readonly outcome: "denied" } & Accounting)
  | ({ readonly outcome: "escalate" } & Accounting)
  | { readonly outcome: "replayed"; readonly closedJti: string }
  | { readonly outcome: "already_in_flight"; readonly openJti: string };

export async function attemptSpend(
  sql: Sql | TransactionSql,
  input: AttemptInput,
): Promise<AttemptResult> {
  const currency = input.request.amount.currency;

  return withTxn(sql, async (tx) => {
    // Create-and-lock in ONE statement.
    //
    // The obvious two-step version — INSERT ... ON CONFLICT DO NOTHING,
    // then SELECT ... FOR UPDATE — deadlocks. DO NOTHING takes a
    // speculative-insertion lock on the index entry and then releases it,
    // and the FOR UPDATE that follows acquires the tuple lock separately,
    // so concurrent callers can acquire the two in opposite orders.
    //
    // ON CONFLICT DO UPDATE holds a single row-level lock throughout, and
    // RETURNING hands back the row as it stands AFTER any transaction we
    // waited on has committed. That post-wait re-read is what makes the
    // budget arithmetic correct under contention; it is the whole reason
    // the balance is not read before the lock.
    const locked = await tx<{ spent_minor: bigint; actions: number; currency: CurrencyCode }[]>`
			INSERT INTO mandate_spend (open_jti, currency)
			VALUES (${input.openJti}, ${currency})
			ON CONFLICT (open_jti)
			DO UPDATE SET updated_at = mandate_spend.updated_at
			RETURNING spent_minor, actions, currency
		`;

    const row = locked[0];
    if (row === undefined) throw new Error(`mandate_spend row vanished for ${input.openJti}`);

    // The replay guard goes inside the lock, so a second use of the same
    // closed mandate cannot slip between the check and the write.
    //
    // Wrapped in a SAVEPOINT because in Postgres a failed statement poisons
    // the entire transaction: every later command errors until a rollback,
    // and committing an aborted transaction re-raises the original error.
    // Catching 23505 without a savepoint therefore looks like it works and
    // then blows up at commit. The savepoint scopes the damage to this one
    // statement so the transaction survives to report the replay.
    let replayed = false;
    try {
      await tx.savepoint(async (sp) => {
        await sp`
					INSERT INTO consumed_mandates (closed_jti, open_jti)
					VALUES (${input.closedJti}, ${input.openJti})
				`;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      replayed = true;
    }

    if (replayed) return { outcome: "replayed", closedJti: input.closedJti } as const;

    const recent = await tx<{ occurred_at: Date; amount_minor: bigint; currency: CurrencyCode }[]>`
			SELECT occurred_at, amount_minor, currency
			  FROM mandate_actions
			 WHERE open_jti = ${input.openJti}
			 ORDER BY occurred_at DESC
			 LIMIT 1000
		`;

    const state: SpendState = {
      spent: money(row.spent_minor, row.currency),
      actions: row.actions,
      recent: recent.map((a) => ({
        at: Math.floor(a.occurred_at.getTime() / 1000),
        amount: money(a.amount_minor, a.currency),
      })),
    };

    const constraints =
      input.humanApproved === true
        ? input.constraints.filter((c) => c.type !== "spend.escalation_threshold")
        : input.constraints;

    const decision = decide(constraints, input.request, state, input.now);

    const accounting: Accounting = {
      decision,
      spentBefore: state.spent,
      amount: input.request.amount,
      // Reported even on a refusal. "What would have happened" is what
      // makes a DENY record as useful as an ALLOW one.
      spentAfter: money(state.spent.amount + input.request.amount.amount, currency),
      actionsBefore: state.actions,
      actionsAfter: state.actions + 1,
    };

    if (decision.effect !== "permit") {
      // The refusal still commits: the replay guard must hold, or an agent
      // could retry a denied mandate until a concurrent settlement made
      // room for it.
      await input.onDecision?.(tx, accounting);
      return { outcome: decision.effect === "deny" ? "denied" : "escalate", ...accounting };
    }

    try {
      await tx.savepoint(async (sp) => {
        await sp`
					INSERT INTO authorizations (id, open_jti, closed_jti, state, amount_minor, currency)
					VALUES (
						${input.authorizationId}, ${input.openJti}, ${input.closedJti},
						${input.captureImmediately === true ? "captured" : "authorized"},
						${input.request.amount.amount}, ${currency}
					)
				`;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The partial unique index on (open_jti) WHERE state='authorized'
        // is AP2's one-in-flight rule. Nothing was authorised, so the
        // closed mandate has not been spent — drop the replay guard we
        // inserted above and report the typed outcome instead of aborting
        // the transaction with a throw.
        await tx`DELETE FROM consumed_mandates WHERE closed_jti = ${input.closedJti}`;
        return { outcome: "already_in_flight", openJti: input.openJti };
      }
      throw error;
    }

    await tx`
			UPDATE mandate_spend
			   SET spent_minor = spent_minor + ${input.request.amount.amount},
			       actions = actions + 1,
			       updated_at = now()
			 WHERE open_jti = ${input.openJti}
		`;

    await tx`
			INSERT INTO mandate_actions (closed_jti, open_jti, amount_minor, currency)
			VALUES (${input.closedJti}, ${input.openJti}, ${input.request.amount.amount}, ${currency})
		`;

    await post(tx, {
      id: input.authorizationId,
      kind: "hold",
      memo: `authorization hold for ${input.closedJti}`,
      openJti: input.openJti,
      closedJti: input.closedJti,
      postings: holdPostings(input.request.amount),
    });

    await input.onDecision?.(tx, accounting);

    return { outcome: "permitted", authorizationId: input.authorizationId, ...accounting };
  });
}

export class OneInFlightError extends Error {
  constructor(readonly openJti: string) {
    super(
      `mandate ${openJti} already has an outstanding authorization; ` +
        `at most one may be in flight at a time`,
    );
    this.name = "OneInFlightError";
  }
}

/** Current spend under a mandate, for reporting rather than for deciding. */
export async function spendOf(
  sql: Sql,
  openJti: string,
): Promise<{ spent: Money; actions: number } | undefined> {
  const rows = await sql<{ spent_minor: bigint; actions: number; currency: CurrencyCode }[]>`
		SELECT spent_minor, actions, currency FROM mandate_spend WHERE open_jti = ${openJti}
	`;
  const row = rows[0];
  return row === undefined
    ? undefined
    : { spent: money(row.spent_minor, row.currency), actions: row.actions };
}
