/**
 * Transactional outbox for outbound Razorpay calls.
 *
 * "Write the payment row, then call Razorpay" is a dual-write: the process can
 * die between the two, and there is no ordering of those steps that is safe.
 * The intent to call is committed in the same transaction as the row, and a
 * worker performs it later. Delivery is therefore at-least-once, which is why
 * the receipt is derived rather than generated — a replay of `orders.create`
 * with the same receipt is rejected by Razorpay itself.
 *
 * Timeouts become `in_doubt`, not `failed`. A timed-out create may have
 * landed; treating it as a failure and retrying with a fresh receipt is how
 * one purchase becomes two. Recovery is "ask Razorpay about OUR reference",
 * never "try again with a different one".
 */

import type { JsonValue } from "../crypto/canonical.js";
import type { Sql, TransactionSql } from "../db/client.js";

export const OUTBOX_KINDS = ["create_order", "capture_payment", "resolve_in_doubt"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATES = ["pending", "in_flight", "done", "in_doubt", "failed"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export const DEFAULT_LEASE_SECONDS = 15;
export const MAX_ATTEMPTS = 8;

export interface EnqueueInput {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly stream: string;
  readonly payload: JsonValue;
}

export async function enqueue(sql: Sql | TransactionSql, input: EnqueueInput): Promise<void> {
  await sql`
		INSERT INTO outbox (id, kind, stream, payload)
		VALUES (${input.id}, ${input.kind}, ${input.stream}, ${sql.json(input.payload as never)})
	`;
}

export interface Claimed {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly stream: string;
  readonly payload: JsonValue;
  readonly attempts: number;
  readonly state: OutboxState;
}

/**
 * Take the next message that is ready and whose stream is free.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several workers drain the table
 * without two of them taking the same row. The stream check is what keeps a
 * capture from overtaking the order that created it: if another message on
 * the same stream is in flight, this one waits.
 */
export async function claim(
  sql: Sql,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<Claimed | undefined> {
  const rows = await sql<
    {
      id: string;
      kind: OutboxKind;
      stream: string;
      payload: JsonValue;
      attempts: number;
      state: OutboxState;
    }[]
  >`
		UPDATE outbox
		   SET state = 'in_flight',
		       attempts = attempts + 1,
		       lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
		       updated_at = now()
		 WHERE id = (
			SELECT id FROM outbox
			 WHERE state IN ('pending', 'in_doubt')
			   AND NOT (kind = 'create_order' AND state = 'in_doubt')
			   AND next_attempt_at <= now()
			   AND (lease_expires_at IS NULL OR lease_expires_at <= now())
			   AND NOT EXISTS (
				SELECT 1 FROM outbox other
				 WHERE other.stream = outbox.stream
				   AND other.state = 'in_flight'
				   AND other.lease_expires_at > now()
			   )
			   AND NOT (
				kind = 'capture_payment'
				AND EXISTS (
					SELECT 1 FROM outbox earlier
					 WHERE earlier.stream = outbox.stream
					   AND earlier.kind IN ('create_order', 'resolve_in_doubt')
					   AND earlier.state IN ('pending', 'in_doubt', 'in_flight')
				)
			   )
			 ORDER BY created_at
			 FOR UPDATE SKIP LOCKED
			 LIMIT 1
		 )
		 RETURNING id, kind, stream, payload, attempts, state
	`;

  return rows[0];
}

export async function complete(sql: Sql, id: string, result: JsonValue): Promise<void> {
  await sql`
		UPDATE outbox
		   SET state = 'done',
		       result = ${sql.json(result as never)},
		       last_error = NULL,
		       lease_expires_at = NULL,
		       updated_at = now()
		 WHERE id = ${id}
	`;
}

/**
 * The call timed out. We do not know whether it landed.
 *
 * Distinct from {@link fail}: a failure will not succeed on retry, a doubt
 * might already have succeeded. The next attempt must be a lookup of our
 * reference, not a replay of the original call with a new one.
 */
export async function markInDoubt(sql: Sql, id: string, error: string): Promise<void> {
  await sql`
		UPDATE outbox
		   SET state = 'in_doubt',
		       last_error = ${error},
		       lease_expires_at = NULL,
		       next_attempt_at = now() + interval '15 seconds',
		       updated_at = now()
		 WHERE id = ${id}
	`;
}

export async function fail(sql: Sql, id: string, error: string): Promise<void> {
  await sql`
		UPDATE outbox
		   SET state = 'failed',
		       last_error = ${error},
		       lease_expires_at = NULL,
		       updated_at = now()
		 WHERE id = ${id}
	`;
}

/** Transient error: put the message back with exponential backoff. */
export async function retry(sql: Sql, id: string, attempts: number, error: string): Promise<void> {
  const delay = Math.min(2 ** Math.max(0, attempts - 1), 60);

  await sql`
		UPDATE outbox
		   SET state = 'pending',
		       last_error = ${error},
		       lease_expires_at = NULL,
		       next_attempt_at = now() + make_interval(secs => ${delay}),
		       updated_at = now()
		 WHERE id = ${id}
	`;
}

export async function ofStream(sql: Sql, stream: string): Promise<Claimed[]> {
  const rows = await sql<Claimed[]>`
		SELECT id, kind, stream, payload, attempts, state
		  FROM outbox
		 WHERE stream = ${stream}
		 ORDER BY created_at
	`;
  return rows;
}
