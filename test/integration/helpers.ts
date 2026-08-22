import { connect, type Sql } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

const URL =
  process.env.DATABASE_URL ?? "postgres://countersign:countersign@localhost:5432/countersign";

export function testDb(): Sql {
  return connect({ url: URL, max: 20 });
}

/** Every table a test might dirty, children first so CASCADE has little to do. */
const TABLES = [
  "ledger_entries",
  "ledger_transactions",
  "ledger_accounts",
  "mandate_actions",
  "mandate_spend",
  "consumed_mandates",
  "authorizations",
  "nonces",
  "idempotency_keys",
  "audit_records",
  "checkpoints",
  "webhook_events",
  "payments",
  "outbox",
];

/** Build the schema. Safe to call repeatedly; migrations are recorded. */
export async function migrateOnce(sql: Sql): Promise<void> {
  await migrate(sql);
}

/**
 * Empty every table between tests.
 *
 * `ledger_entries` refuses TRUNCATE by design, so the reset runs with
 * `session_replication_role = replica`, which suspends user triggers for the
 * duration. SET LOCAL scopes that to this transaction, so a failure cannot
 * leave the connection with triggers disabled — which would silently turn off
 * the append-only guarantee for whatever ran next.
 *
 * The earlier version dropped and re-migrated the schema per test. Correct,
 * but it cost about seven seconds a test and blew the hook timeout.
 */
export async function truncateAll(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica");
    await tx.unsafe(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    // audit_head is a singleton control row, not data. Truncating it away
    // would leave append() with nothing to lock.
    await tx.unsafe(
      "UPDATE audit_head SET next_seq = 0, last_hash = 'countersign/v1/genesis' WHERE id = TRUE",
    );
  });
}

/** Full rebuild. Only needed when a migration itself is under test. */
export async function resetSchema(sql: Sql): Promise<void> {
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(sql);
}

/**
 * A unique ULID-shaped identifier, encoded against Crockford's base32
 * alphabet — which omits I, L, O and U so an id survives transcription.
 *
 * Encoded against that alphabet DIRECTLY. The tempting shortcut,
 * `n.toString(32).toUpperCase()` with the four illegal letters substituted
 * out, silently merges 18, 21, 24 and 30 onto one character, so four different
 * counters yield the same id. That surfaced as two unexplained "replayed"
 * results in a concurrency test that should have had none.
 *
 * The counter is also left-padded INTO the 26 characters rather than appended
 * and truncated; appending puts it past the cut and every id comes out
 * identical.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let counter = 0;
const issued = new Set<string>();

export function testId(prefix = "01K3QF"): string {
  counter += 1;

  let n = counter;
  let body = "";
  do {
    body = CROCKFORD[n % 32] + body;
    n = Math.floor(n / 32);
  } while (n > 0);

  const id = prefix + body.padStart(26 - prefix.length, "0");

  // Cheap, and it turns a subtle wrong-answer failure into an obvious one.
  if (issued.has(id)) throw new Error(`testId generated a duplicate: ${id}`);
  issued.add(id);

  return id;
}
