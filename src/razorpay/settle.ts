/**
 * Local payment records and the worker that talks to Razorpay for them.
 *
 * A payment row is created in the same transaction as the spend and the
 * outbox message. The worker is what actually calls Razorpay, and the only
 * thing it is allowed to conclude from a timeout is that it does not know.
 */

import type { JsonValue } from "../crypto/canonical.js";
import type { Sql, TransactionSql } from "../db/client.js";
import { isUniqueViolation, withTxn } from "../db/client.js";
import { capturePostings, post, refundPostings, releasePostings } from "../ledger/ledger.js";
import { type CurrencyCode, money } from "../money/money.js";
import {
  type Razorpay,
  RazorpayApiError,
  RazorpayDuplicateReceipt,
  type RazorpayOrder,
  RazorpayTimeout,
} from "./client.js";
import {
  type Claimed,
  claim,
  complete,
  type EnqueueInput,
  enqueue,
  fail,
  MAX_ATTEMPTS,
  markInDoubt,
  retry,
} from "./outbox.js";
import { deriveReceipt } from "./receipt.js";
import { verifyPaymentSignature } from "./signature.js";
import { advance, isContradictory, isPaymentState, type PaymentState } from "./state.js";

export interface IntendInput {
  readonly authorizationId: string;
  readonly openJti: string;
  readonly closedJti: string;
  readonly requestHash: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly outboxId: string;
}

export interface IntendedPayment {
  readonly receipt: string;
}

/**
 * Record that we intend to charge, and queue the Razorpay call.
 *
 * Must run inside the caller's transaction. If this can commit while the spend
 * rolls back, we will create an order for a purchase we refused.
 */
export async function intendPayment(
  tx: TransactionSql,
  input: IntendInput,
): Promise<IntendedPayment> {
  const receipt = deriveReceipt(input.closedJti, input.requestHash);

  await tx`
		INSERT INTO payments (
			receipt, authorization_id, open_jti, closed_jti,
			amount_minor, currency, state
		)
		VALUES (
			${receipt}, ${input.authorizationId}, ${input.openJti}, ${input.closedJti},
			${input.amountMinor}, ${input.currency}, 'created'
		)
	`;

  const payload: JsonValue = {
    receipt,
    amount_minor: input.amountMinor.toString(),
    currency: input.currency,
  };

  const message: EnqueueInput = {
    id: input.outboxId,
    kind: "create_order",
    stream: receipt,
    payload,
  };
  await enqueue(tx, message);

  return { receipt };
}

export async function attachSignature(
  sql: Sql,
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): Promise<boolean> {
  const ok = verifyPaymentSignature(orderId, paymentId, signature, keySecret);

  await sql`
		UPDATE payments
		   SET payment_id = ${paymentId},
		       signature = ${signature},
		       signature_verified = ${ok},
		       updated_at = now()
		 WHERE order_id = ${orderId}
	`;

  return ok;
}

export interface DrainResult {
  readonly id: string;
  readonly kind: string;
  readonly outcome: "done" | "in_doubt" | "failed" | "retried";
  readonly detail: string;
}

/**
 * Perform one ready outbox message.
 *
 * Returns undefined when the queue is empty. Calling it in a loop is the
 * worker; calling it once is what the tests do.
 */
export async function drainOne(sql: Sql, razorpay: Razorpay): Promise<DrainResult | undefined> {
  const claimed = await claim(sql);
  if (claimed === undefined) return undefined;

  try {
    switch (claimed.kind) {
      case "create_order":
        return await createOrder(sql, razorpay, claimed.id, claimed.payload, claimed.attempts);
      case "capture_payment":
        return await capturePayment(sql, razorpay, claimed.id, claimed.payload, claimed.attempts);
      case "resolve_in_doubt":
        return await resolveInDoubt(sql, razorpay, claimed.id, claimed.payload, claimed.attempts);
      default:
        await fail(sql, claimed.id, `unknown outbox kind ${claimed.kind}`);
        return { id: claimed.id, kind: claimed.kind, outcome: "failed", detail: "unknown kind" };
    }
  } catch (error) {
    if (error instanceof RazorpayTimeout) {
      await flagPayment(sql, receiptOf(claimed.payload), error.message);
      // A timed-out create must not be claimable again. markInDoubt would
      // put it back on the queue in 15s and drainOne would call createOrder
      // a second time — a new Razorpay order, same receipt. Fail the create
      // row; only resolve_in_doubt may run. Other kinds can still sit in
      // doubt and be retried as themselves.
      if (claimed.kind === "create_order") {
        await fail(sql, claimed.id, error.message);
      } else {
        await markInDoubt(sql, claimed.id, error.message);
      }
      return { id: claimed.id, kind: claimed.kind, outcome: "in_doubt", detail: error.message };
    }

    if (error instanceof RazorpayDuplicateReceipt) {
      // The call landed on an earlier attempt, or Razorpay already has this
      // receipt. Looking it up is what makes the second line of defence work.
      const found = await razorpay.findOrderByReceipt(error.receipt || receiptOf(claimed.payload));
      if (found !== undefined) {
        await rememberOrder(sql, found);
        await complete(sql, claimed.id, { order_id: found.id, recovered: true });
        return {
          id: claimed.id,
          kind: claimed.kind,
          outcome: "done",
          detail: `recovered existing order ${found.id}`,
        };
      }
    }

    if (error instanceof RazorpayApiError && error.status >= 400 && error.status < 500) {
      await fail(sql, claimed.id, error.message);
      await abandonIfCreate(sql, claimed, error.message);
      return { id: claimed.id, kind: claimed.kind, outcome: "failed", detail: error.message };
    }

    if (claimed.attempts >= MAX_ATTEMPTS) {
      const reason = error instanceof Error ? error.message : "exhausted retries";
      await fail(sql, claimed.id, reason);
      await abandonIfCreate(sql, claimed, reason);
      return { id: claimed.id, kind: claimed.kind, outcome: "failed", detail: "exhausted retries" };
    }

    await retry(
      sql,
      claimed.id,
      claimed.attempts,
      error instanceof Error ? error.message : "unknown",
    );
    return {
      id: claimed.id,
      kind: claimed.kind,
      outcome: "retried",
      detail: error instanceof Error ? error.message : "unknown",
    };
  }
}

export async function drain(sql: Sql, razorpay: Razorpay, limit = 20): Promise<DrainResult[]> {
  const results: DrainResult[] = [];
  for (let i = 0; i < limit; i++) {
    const one = await drainOne(sql, razorpay);
    if (one === undefined) break;
    results.push(one);
  }
  return results;
}

async function createOrder(
  sql: Sql,
  razorpay: Razorpay,
  id: string,
  payload: JsonValue,
  _attempts: number,
): Promise<DrainResult> {
  const receipt = receiptOf(payload);
  const amount = minorField(payload, "amount_minor");
  const currency = stringField(payload, "currency");

  const order = await razorpay.createOrder({
    amountMinor: amount,
    currency,
    receipt,
  });

  await rememberOrder(sql, order);
  await complete(sql, id, { order_id: order.id });
  return { id, kind: "create_order", outcome: "done", detail: order.id };
}

async function capturePayment(
  sql: Sql,
  razorpay: Razorpay,
  id: string,
  payload: JsonValue,
  _attempts: number,
): Promise<DrainResult> {
  const paymentId = stringField(payload, "payment_id");
  const amount = minorField(payload, "amount_minor");
  const currency = stringField(payload, "currency");

  const captured = await razorpay.capture(paymentId, amount, currency);
  await applyRemoteState(sql, captured.orderId, captured.id, "captured", captured.feeMinor);
  await complete(sql, id, { payment_id: captured.id, status: captured.status });
  return { id, kind: "capture_payment", outcome: "done", detail: captured.id };
}

async function resolveInDoubt(
  sql: Sql,
  razorpay: Razorpay,
  id: string,
  payload: JsonValue,
  attempts: number,
): Promise<DrainResult> {
  const receipt = receiptOf(payload);
  const found = await razorpay.findOrderByReceipt(receipt);

  if (found !== undefined) {
    await rememberOrder(sql, found);
    await complete(sql, id, { order_id: found.id, resolved: true });
    await completeSiblingCreate(sql, receipt, found.id);
    return { id, kind: "resolve_in_doubt", outcome: "done", detail: found.id };
  }

  // Still nothing. That is not a failure — the create may not have landed,
  // or it may not be visible yet. Keep asking.
  if (attempts >= MAX_ATTEMPTS) {
    await markInDoubt(sql, id, `no order for ${receipt} after ${attempts} lookups`);
    return { id, kind: "resolve_in_doubt", outcome: "in_doubt", detail: "still unresolved" };
  }

  await markInDoubt(sql, id, `no order for ${receipt} yet`);
  return { id, kind: "resolve_in_doubt", outcome: "in_doubt", detail: "not yet visible" };
}

async function rememberOrder(sql: Sql, order: RazorpayOrder): Promise<void> {
  await sql`
		UPDATE payments
		   SET order_id = COALESCE(order_id, ${order.id}),
		       in_doubt = FALSE,
		       in_doubt_reason = NULL,
		       updated_at = now()
		 WHERE receipt = ${order.receipt}
	`;
}

/** The original create_order is failed on timeout. Once lookup succeeds, retire it. */
async function completeSiblingCreate(sql: Sql, receipt: string, orderId: string): Promise<void> {
  await sql`
		UPDATE outbox
		   SET state = 'done',
		       result = ${sql.json({ order_id: orderId, recovered: true } as never)},
		       last_error = NULL,
		       lease_expires_at = NULL,
		       updated_at = now()
		 WHERE stream = ${receipt}
		   AND kind = 'create_order'
		   AND state IN ('failed', 'in_doubt')
	`;
}

async function flagPayment(sql: Sql, receipt: string, reason: string): Promise<void> {
  await sql`
		UPDATE payments
		   SET in_doubt = TRUE,
		       in_doubt_reason = ${reason},
		       updated_at = now()
		 WHERE receipt = ${receipt}
	`;

  // The next thing the worker should do is ask Razorpay about this receipt,
  // not replay create_order. Replaying a create that may have landed is the
  // bug; a lookup is not.
  await sql`
		INSERT INTO outbox (id, kind, stream, payload)
		VALUES (
			${`resolve:${receipt}`},
			'resolve_in_doubt',
			${receipt},
			${sql.json({ receipt } as never)}
		)
		ON CONFLICT (id) DO NOTHING
	`;
}

async function abandonIfCreate(sql: Sql, claimed: Claimed, reason: string): Promise<void> {
  if (claimed.kind !== "create_order") return;
  await abandonIntent(sql, receiptOf(claimed.payload), reason);
}

/**
 * Razorpay refused to create the order, or we stopped trying. No money
 * moved and none will: the payment is failed, the hold is released in the
 * ledger, and the authorization leaves the `authorized` state that AP2's
 * one-in-flight index counts. Without this, one refused order — wrong API
 * keys are enough — would cap the mandate at a single purchase for ever.
 *
 * The mandate's spend counter keeps the amount. A refused order still
 * counted as an action against the budget the human signed; giving it back
 * automatically would let a run of refusals be retried without limit. That
 * is the fail-closed direction, and a human reconciles the difference.
 *
 * A timeout never comes here: the create MAY have landed, so the payment is
 * flagged in doubt and a lookup is queued instead.
 */
export async function abandonIntent(sql: Sql, receipt: string, reason: string): Promise<void> {
  await withTxn(sql, async (tx) => {
    const rows = await tx<
      { authorization_id: string; amount_minor: bigint; currency: CurrencyCode }[]
    >`
			UPDATE payments
			   SET state = 'failed',
			       in_doubt = FALSE,
			       in_doubt_reason = ${reason},
			       updated_at = now()
			 WHERE receipt = ${receipt}
			   AND state = 'created'
			   AND order_id IS NULL
			RETURNING authorization_id, amount_minor, currency
		`;
    const row = rows[0];
    if (row === undefined) return;

    try {
      await post(tx, {
        id: `${row.authorization_id}:release`,
        kind: "release",
        memo: `release: ${reason}`,
        externalRef: receipt,
        postings: releasePostings(money(row.amount_minor, row.currency)),
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    await tx`
			UPDATE authorizations
			   SET state = 'failed', updated_at = now()
			 WHERE id = ${row.authorization_id}
			   AND state = 'authorized'
		`;
  });
}

/**
 * Move a local payment to match what Razorpay told us, and book the capture
 * if this is the first time we have heard that money moved.
 *
 * The ledger transaction id is derived from the authorization, so a second
 * capture event — webhook and outbox both firing — posts once.
 */
export async function applyRemoteState(
  sql: Sql | TransactionSql,
  orderId: string,
  paymentId: string,
  incoming: PaymentState,
  feeMinor = 0n,
): Promise<{ applied: boolean; next: PaymentState }> {
  return withTxn(sql, async (tx) => {
    const rows = await tx<
      {
        receipt: string;
        authorization_id: string;
        state: string;
        amount_minor: bigint;
        currency: CurrencyCode;
      }[]
    >`
			SELECT receipt, authorization_id, state, amount_minor, currency
			  FROM payments
			 WHERE order_id = ${orderId}
			   FOR UPDATE
		`;

    const row = rows[0];
    if (row === undefined) return { applied: false, next: incoming };
    if (!isPaymentState(row.state)) return { applied: false, next: incoming };

    await tx`
			UPDATE payments
			   SET payment_id = COALESCE(payment_id, ${paymentId}),
			       in_doubt = FALSE,
			       in_doubt_reason = NULL,
			       updated_at = now()
			 WHERE receipt = ${row.receipt}
		`;

    // A refund that never captured is contradictory. Rank would otherwise
    // let refunded (50) skip captured (40) from created/authorized.
    if (isContradictory(row.state, incoming)) {
      return { applied: false, next: row.state };
    }

    const transition = advance(row.state, incoming);
    if (!transition.applied) return { applied: false, next: transition.next };

    await tx`
			UPDATE payments SET state = ${transition.next}, updated_at = now()
			 WHERE receipt = ${row.receipt}
		`;

    const amount = money(row.amount_minor, row.currency);
    const fee = money(feeMinor, row.currency);

    if (transition.next === "captured") {
      try {
        await post(tx, {
          id: `${row.authorization_id}:capture`,
          kind: "capture",
          memo: `capture ${paymentId}`,
          externalRef: paymentId,
          postings: capturePostings(amount, fee),
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    if (transition.next === "failed") {
      try {
        await post(tx, {
          id: `${row.authorization_id}:release`,
          kind: "release",
          memo: `release ${paymentId}`,
          externalRef: paymentId,
          postings: releasePostings(amount),
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    if (transition.next === "refunded") {
      try {
        await post(tx, {
          id: `${row.authorization_id}:refund`,
          kind: "refund",
          memo: `refund ${paymentId}`,
          externalRef: paymentId,
          postings: refundPostings(amount, fee),
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    // One-in-flight is a partial unique index on state='authorized'.
    // Leaving the row there after Razorpay captures or fails is how a
    // mandate that still has budget cannot buy a second time.
    if (
      transition.next === "captured" ||
      transition.next === "failed" ||
      transition.next === "refunded"
    ) {
      await tx`
				UPDATE authorizations
				   SET state = ${transition.next}, updated_at = now()
				 WHERE id = ${row.authorization_id}
				   AND state = 'authorized'
			`;
    }

    return { applied: true, next: transition.next };
  });
}

function receiptOf(payload: JsonValue): string {
  return stringField(payload, "receipt");
}

function asObject(payload: JsonValue): { readonly [key: string]: JsonValue } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("outbox payload is not an object");
  }
  return payload as { readonly [key: string]: JsonValue };
}

function stringField(payload: JsonValue, key: string): string {
  const value = asObject(payload)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`outbox payload is missing ${key}`);
  }
  return value;
}

function minorField(payload: JsonValue, key: string): bigint {
  const value = asObject(payload)[key];
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  // Older outbox rows and a few tests still write a JSON number. Accept
  // those if they are safe integers; new writes use a string.
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`outbox payload is missing integer ${key}`);
}
