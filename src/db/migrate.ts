/**
 * Migration runner.
 *
 * Deliberately small and boring. Migrations are numbered, applied in order,
 * each inside a transaction, and recorded with the SHA-256 of the file that
 * was applied.
 *
 * Recording the digest is the part worth having: editing a migration that has
 * already run is a silent way for two environments to diverge, and the next
 * run refuses rather than pretending the schemas match.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestString } from "../crypto/digest.js";
import type { Sql } from "./client.js";

/**
 * Arbitrary but fixed. Two runners racing must pick the same lock.
 *
 * Decimal rather than hex because the formatter rewrites hex literals with
 * numeric separators and places one immediately after the `0x`, which is not
 * valid syntax.
 */
const MIGRATION_LOCK_ID = 3_235_373_415;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
}

export function loadMigrations(dir = migrationsDir()): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (match === null) {
        throw new Error(`migration filename must be NNNN_name.sql, got: ${file}`);
      }
      const sql = readFileSync(join(dir, file), "utf8");
      return {
        version: Number(match[1]),
        name: match[2] as string,
        sql,
        sha256: digestString(sql),
      };
    });
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyCurrent: number;
}

export async function migrate(sql: Sql, dir = migrationsDir()): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);

  await sql`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER     PRIMARY KEY,
			name       TEXT        NOT NULL,
			sha256     TEXT        NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;

  // A session-level advisory lock, so two processes starting at once (a
  // deploy and a test run, say) serialise instead of both trying to create
  // the same table.
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;

  try {
    const rows = await sql<{ version: number; name: string; sha256: string }[]>`
			SELECT version, name, sha256 FROM schema_migrations
		`;
    const applied = new Map(rows.map((r) => [r.version, r]));
    const newlyApplied: string[] = [];

    for (const migration of migrations) {
      const previous = applied.get(migration.version);

      if (previous !== undefined) {
        if (previous.sha256 !== migration.sha256) {
          throw new Error(
            `migration ${migration.version}_${migration.name} has changed since it was ` +
              `applied. Editing an applied migration lets environments diverge silently — ` +
              `add a new migration instead.`,
          );
        }
        continue;
      }

      // `sql.file`-style execution is avoided: `sql.unsafe` runs the file
      // verbatim, which is required because migrations contain multiple
      // statements and dollar-quoted function bodies that a parameterised
      // query would mangle. The input is a file on disk under version
      // control, not user input.
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
					INSERT INTO schema_migrations (version, name, sha256)
					VALUES (${migration.version}, ${migration.name}, ${migration.sha256})
				`;
      });

      newlyApplied.push(`${migration.version}_${migration.name}`);
    }

    return { applied: newlyApplied, alreadyCurrent: migrations.length - newlyApplied.length };
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }
}
