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

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db → ../../migrations ; dist/src/db → one level deeper, because tsc
  // compiles under dist/src but never copies .sql files. Without the second
  // candidate the compiled server cannot boot at all.
  const candidates = [
    join(here, "..", "..", "migrations"),
    join(here, "..", "..", "..", "migrations"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`migrations directory not found; looked in: ${candidates.join(", ")}`);
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

  // One transaction, one connection, one transaction-scoped advisory lock.
  // Two processes starting at once (a deploy and a test run, say) serialise
  // instead of both trying to create the same table. The lock MUST be
  // transaction-scoped: a session lock taken through a pooled handle can be
  // acquired on one backend and "released" on another, which leaves it held
  // by a connection nobody owns until the pool recycles it.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;

    const rows = await tx<{ version: number; name: string; sha256: string }[]>`
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

      // `sql.file`-style execution is avoided: `unsafe` runs the file
      // verbatim, which is required because migrations contain multiple
      // statements and dollar-quoted function bodies that a parameterised
      // query would mangle. The input is a file on disk under version
      // control, not user input. A savepoint per migration keeps the error
      // pointing at the file that failed; the outer transaction still makes
      // the whole run all-or-nothing.
      await tx.savepoint(async (sp) => {
        await sp.unsafe(migration.sql);
        await sp`
					INSERT INTO schema_migrations (version, name, sha256)
					VALUES (${migration.version}, ${migration.name}, ${migration.sha256})
				`;
      });

      newlyApplied.push(`${migration.version}_${migration.name}`);
    }

    return { applied: newlyApplied, alreadyCurrent: migrations.length - newlyApplied.length };
  });
}
