/**
 * Reset the tables the rehearsal writes.
 *
 * Same trick as the integration helpers: `ledger_entries` refuses TRUNCATE,
 * so the reset runs with triggers suspended for one transaction only.
 */

import type { Sql } from "../db/client.js";

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

export async function resetDemoData(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica");
    await tx.unsafe(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    await tx.unsafe(
      "UPDATE audit_head SET next_seq = 0, last_hash = 'countersign/v1/genesis' WHERE id = TRUE",
    );
  });
}
