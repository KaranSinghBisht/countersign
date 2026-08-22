/**
 * Idempotency keys.
 *
 * The ordering is the entire guarantee, and it is worth stating plainly:
 *
 *   the key row COMMITS before the outbound Razorpay call is made.
 *
 * Any variation on `if (await exists(key)) return cached` is a TOCTOU race.
 * Two concurrent retries both read "absent", both proceed, and the buyer is
 * charged twice. Here the insert IS the check — a duplicate raises 23505 and
 * the loser reads the winner's row, which the database can arbitrate
 * correctly and we cannot.
 *
 * Four outcomes, matching what a caller has to do next:
 *
 *   proceed   — this caller owns the key and should do the work
 *   replay    — the work is already done; return the stored response
 *   inFlight  — someone else owns it right now; 409 with Retry-After
 *   mismatch  — same key, different request body; 422, because this is a
 *               client bug and serving the first response would hide it
 */

import type { JsonValue } from "../crypto/canonical.js";
import { digestJson } from "../crypto/digest.js";
import { isUniqueViolation, type Sql } from "../db/client.js";

/** How long one attempt may hold a key before another may take it over. */
export const DEFAULT_LEASE_SECONDS = 30;

export type IdempotencyOutcome =
  | { readonly kind: "proceed"; readonly fingerprint: string }
  | { readonly kind: "replay"; readonly status: number; readonly body: JsonValue }
  | { readonly kind: "inFlight"; readonly retryAfterSeconds: number }
  | { readonly kind: "mismatch" };

export interface ClaimInput {
  readonly actorId: string;
  readonly key: string;
  /** The request body, canonicalised and hashed to detect key reuse. */
  readonly request: JsonValue;
  readonly leaseSeconds?: number;
}

interface KeyRow {
  fingerprint: string;
  state: "in_flight" | "succeeded" | "failed";
  lease_expired: boolean;
  lease_remaining_seconds: number;
  response_status: number | null;
  response_body: JsonValue | null;
}

export async function claim(sql: Sql, input: ClaimInput): Promise<IdempotencyOutcome> {
  const fingerprint = digestJson(input.request);
  const lease = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  try {
    await sql`
			INSERT INTO idempotency_keys (actor_id, idem_key, fingerprint, state, lease_expires_at)
			VALUES (
				${input.actorId}, ${input.key}, ${fingerprint}, 'in_flight',
				now() + make_interval(secs => ${lease})
			)
		`;
    return { kind: "proceed", fingerprint };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  // Someone got there first. Everything below is deciding which of them.
  const existing = await load(sql, input.actorId, input.key);
  if (existing === undefined) {
    // The row vanished between the conflict and the read, which means a
    // lease was reaped. Retrying the claim is correct and terminates,
    // because the second attempt either inserts or finds a live row.
    return claim(sql, input);
  }

  // Checked before state: a mismatched body is a client bug regardless of
  // whether the original succeeded, and replaying someone else's response to
  // a different request would hide it.
  if (existing.fingerprint !== fingerprint) return { kind: "mismatch" };

  if (existing.state !== "in_flight") {
    return {
      kind: "replay",
      status: existing.response_status ?? 500,
      body: existing.response_body ?? null,
    };
  }

  if (!existing.lease_expired) {
    return {
      kind: "inFlight",
      // Never zero: a Retry-After of 0 invites an immediate hot retry
      // against a request that is still running.
      retryAfterSeconds: Math.max(1, Math.ceil(existing.lease_remaining_seconds)),
    };
  }

  // The lease expired, so the previous holder is presumed dead. Take it over
  // with a conditional UPDATE rather than an unconditional one — if two
  // callers reach this line together, only the one whose UPDATE matches the
  // still-expired row wins, and the other is told to wait.
  const takenOver = await sql`
		UPDATE idempotency_keys
		   SET lease_expires_at = now() + make_interval(secs => ${lease}),
		       updated_at = now()
		 WHERE actor_id = ${input.actorId}
		   AND idem_key = ${input.key}
		   AND state = 'in_flight'
		   AND lease_expires_at <= now()
		RETURNING actor_id
	`;

  return takenOver.length === 1
    ? { kind: "proceed", fingerprint }
    : { kind: "inFlight", retryAfterSeconds: 1 };
}

/**
 * Record the outcome so later retries replay it instead of redoing the work.
 *
 * A failure is recorded too. "We tried and it failed" is a real answer, and
 * leaving the key in flight means the client retries into a lease wait rather
 * than learning what happened.
 */
export async function complete(
  sql: Sql,
  actorId: string,
  key: string,
  status: number,
  body: JsonValue,
): Promise<void> {
  const state = status >= 200 && status < 400 ? "succeeded" : "failed";

  await sql`
		UPDATE idempotency_keys
		   SET state = ${state},
		       response_status = ${status},
		       response_body = ${sql.json(body as never)},
		       updated_at = now()
		 WHERE actor_id = ${actorId} AND idem_key = ${key}
	`;
}

async function load(sql: Sql, actorId: string, key: string): Promise<KeyRow | undefined> {
  const rows = await sql<KeyRow[]>`
		SELECT
			fingerprint,
			state,
			lease_expires_at <= now() AS lease_expired,
			GREATEST(0, EXTRACT(EPOCH FROM (lease_expires_at - now())))::float8
				AS lease_remaining_seconds,
			response_status,
			response_body
		FROM idempotency_keys
		WHERE actor_id = ${actorId} AND idem_key = ${key}
	`;
  return rows[0];
}

/**
 * Release keys whose lease expired without ever completing.
 *
 * Optional — `claim` already takes over an expired lease on demand, so this is
 * housekeeping rather than a correctness requirement. Returns the number
 * removed so a caller can log it and notice if it is large, which would mean
 * requests are dying mid-flight.
 */
export async function reapExpiredLeases(sql: Sql): Promise<number> {
  const removed = await sql`
		DELETE FROM idempotency_keys
		 WHERE state = 'in_flight' AND lease_expires_at <= now()
		RETURNING actor_id
	`;
  return removed.length;
}
