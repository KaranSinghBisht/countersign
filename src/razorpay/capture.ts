/**
 * Capture, queued.
 *
 * Orders are created with `payment_capture: 0`: Razorpay authorises the
 * payment and waits for us to capture it, and an authorisation nobody
 * captures is auto-refunded after five days. So an authorised payment must
 * become a `capture_payment` outbox message — from the webhook, and from the
 * payer page's own callback, whichever arrives first. The message id is the
 * payment id, so both callers can race and exactly one message exists.
 */

import type { Sql, TransactionSql } from "../db/client.js";

export interface CaptureInput {
  readonly receipt: string;
  readonly paymentId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** Queue the capture; false when it was already queued. */
export async function queueCapture(
  sql: Sql | TransactionSql,
  input: CaptureInput,
): Promise<boolean> {
  const payload = {
    receipt: input.receipt,
    payment_id: input.paymentId,
    amount_minor: input.amountMinor.toString(),
    currency: input.currency,
  };
  const inserted = await sql`
		INSERT INTO outbox (id, kind, stream, payload)
		VALUES (${`capture:${input.paymentId}`}, 'capture_payment', ${input.receipt}, ${sql.json(payload as never)})
		ON CONFLICT (id) DO NOTHING
		RETURNING id
	`;
  return inserted.length > 0;
}

/**
 * Queue the capture for a payment Razorpay just authorised against one of our
 * orders. A payment we do not know is not ours to capture: nothing happens.
 */
export async function captureAuthorized(
  sql: Sql | TransactionSql,
  orderId: string,
  paymentId: string,
): Promise<boolean> {
  const rows = await sql<{ receipt: string; amount_minor: bigint; currency: string }[]>`
		SELECT receipt, amount_minor, currency FROM payments WHERE order_id = ${orderId}
	`;
  const row = rows[0];
  if (row === undefined) return false;
  return queueCapture(sql, {
    receipt: row.receipt,
    paymentId,
    amountMinor: row.amount_minor,
    currency: row.currency,
  });
}
