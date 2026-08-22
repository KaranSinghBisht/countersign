/**
 * Server-issued challenge nonces.
 *
 * `jti` is chosen by the agent, so a compromised agent can pre-mint a stack of
 * mandates and hold them. Requiring the closed mandate to also commit to a
 * value WE chose, after the request began, is what makes it a challenge rather
 * than a claim.
 *
 * Consumption is a conditional UPDATE, not a read followed by a write. Two
 * concurrent redemptions of one nonce must not both succeed, and the only
 * reliable arbiter of that is the database.
 */

import { randomBytes } from "node:crypto";
import { b64u } from "../crypto/encoding.js";
import type { Sql } from "../db/client.js";

/** 128 bits. Guessing one inside its lifetime is not a realistic attack. */
const NONCE_BYTES = 16;

export const DEFAULT_NONCE_TTL_SECONDS = 300;

export interface IssuedNonce {
  readonly nonce: string;
  readonly expiresAt: Date;
}

export async function issue(
  sql: Sql,
  issuedTo: string,
  ttlSeconds = DEFAULT_NONCE_TTL_SECONDS,
): Promise<IssuedNonce> {
  const nonce = b64u(randomBytes(NONCE_BYTES));

  const rows = await sql<{ expires_at: Date }[]>`
		INSERT INTO nonces (nonce, issued_to, expires_at)
		VALUES (${nonce}, ${issuedTo}, now() + make_interval(secs => ${ttlSeconds}))
		RETURNING expires_at
	`;

  const row = rows[0];
  if (row === undefined) throw new Error("failed to issue nonce");
  return { nonce, expiresAt: row.expires_at };
}

export type ConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unknown" | "already_used" | "expired" };

/**
 * Redeem a nonce exactly once.
 *
 * The UPDATE carries all three conditions, so the single statement both
 * decides and acts. A separate SELECT would let two callers each see an
 * unconsumed nonce before either wrote.
 */
export async function consume(sql: Sql, nonce: string): Promise<ConsumeResult> {
  const updated = await sql`
		UPDATE nonces
		   SET consumed_at = now()
		 WHERE nonce = ${nonce}
		   AND consumed_at IS NULL
		   AND expires_at > now()
		RETURNING nonce
	`;

  if (updated.length === 1) return { ok: true };

  // The UPDATE matched nothing. Distinguish why, for the error message only —
  // the decision has already been made and cannot be changed by this read.
  const rows = await sql<{ consumed: boolean; expired: boolean }[]>`
		SELECT consumed_at IS NOT NULL AS consumed, expires_at <= now() AS expired
		  FROM nonces WHERE nonce = ${nonce}
	`;

  const row = rows[0];
  if (row === undefined) return { ok: false, reason: "unknown" };
  return { ok: false, reason: row.consumed ? "already_used" : "expired" };
}

/** Delete expired nonces. Housekeeping; expiry is enforced in `consume`. */
export async function purgeExpired(sql: Sql): Promise<number> {
  const removed = await sql`DELETE FROM nonces WHERE expires_at <= now() RETURNING nonce`;
  return removed.length;
}
