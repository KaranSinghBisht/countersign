/**
 * Postgres connection.
 *
 * One decision here matters more than the rest: BIGINT columns are returned as
 * `bigint`, not as JavaScript numbers.
 *
 * postgres.js defaults to `string` for int8 precisely because a number would
 * silently lose precision above 2^53. Either default is a trap for money — a
 * string sneaks into arithmetic as `"100" + 1 === "1001"`, and a number rounds.
 * Since every amount in this system is already a bigint count of minor units,
 * the driver is configured to hand back the same type the domain uses, so no
 * conversion layer exists to get wrong.
 */

import postgres from "postgres";

export type Sql = postgres.Sql<{ bigint: bigint }>;
export type TransactionSql = postgres.TransactionSql<{ bigint: bigint }>;

export interface ConnectOptions {
  readonly url: string;
  readonly max?: number;
  /** Fail a connection attempt rather than queueing forever. */
  readonly connectTimeoutSeconds?: number;
  readonly onNotice?: (notice: unknown) => void;
}

export function connect(options: ConnectOptions): Sql {
  return postgres(options.url, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,

    types: {
      bigint: postgres.BigInt,
    },

    // Postgres notices are not errors, but they carry things like
    // "identifier will be truncated" that are worth seeing rather than
    // swallowing.
    onnotice: options.onNotice ?? (() => {}),
  });
}

/**
 * Is this error a unique-constraint violation?
 *
 * Used to turn a race into a decision. Checking whether a row exists and then
 * inserting it is a TOCTOU bug under concurrency; inserting and catching 23505
 * lets the database arbitrate, which it can do correctly and we cannot.
 */
export const isUniqueViolation = (error: unknown): boolean => pgCode(error) === "23505";

/** Is this a CHECK or constraint-trigger failure, such as an unbalanced entry? */
export const isCheckViolation = (error: unknown): boolean => pgCode(error) === "23514";

/** Is this a foreign-key violation, such as an entry naming an unknown account? */
export const isForeignKeyViolation = (error: unknown): boolean => pgCode(error) === "23503";

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
