import { connect, type Sql } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

const URL =
  process.env.DATABASE_URL ?? "postgres://countersign:countersign@localhost:5432/countersign";

export function testDb(): Sql {
  return connect({ url: URL, max: 20 });
}

/**
 * Migrate once, then truncate between tests.
 *
 * `ledger_entries` refuses TRUNCATE by design, so resetting has to drop the
 * schema rather than empty it. That is the trigger doing its job, and the test
 * helper working around it is the expected cost of an append-only table.
 */
export async function resetSchema(sql: Sql): Promise<void> {
  await sql.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate(sql);
}

/**
 * A unique ULID-shaped identifier. Crockford base32, so no I, L, O or U.
 *
 * The counter is left-padded INTO the 26 characters rather than appended and
 * then truncated. Appending puts it past the cut, so every id comes out
 * identical and only tests that post twice notice.
 */
let counter = 0;
export function testId(prefix = "01K3QF"): string {
  counter += 1;
  const body = counter
    .toString(32)
    .toUpperCase()
    .replace(/[ILOU]/g, "X");
  return prefix + body.padStart(26 - prefix.length, "0");
}
