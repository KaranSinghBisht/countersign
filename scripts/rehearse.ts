#!/usr/bin/env tsx
/**
 * Eight rehearsed failures. This is the live demo.
 *
 *     make demo
 *     pnpm exec tsx scripts/rehearse.ts
 *     pnpm exec tsx scripts/rehearse.ts --offline   # skip webhook + duplicate
 *
 * Webhook and duplicate need postgres (`make up`). The other six do not.
 * Rehearses in its own database (countersign_demo, created on first run), so
 * a rehearsal never disturbs `make dev`'s audit log mid-demo.
 * Always writes `.countersign/export` + `.countersign/trust.demo.json` for the USB CLI.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { assertSafeToTruncate } from "../src/db/safety.js";
import { formatRehearsal, runRehearsal } from "../src/demo/rehearse.js";
import { writeDemoExport } from "../src/demo/sample-bundle.js";

const DEFAULT_URL = "postgres://countersign:countersign@localhost:5432/countersign_demo";
const URL = process.env.DATABASE_URL ?? DEFAULT_URL;

/**
 * The webhook and duplicate rehearsals truncate every table they touch, so by
 * default the rehearsal runs in its own database — `make buy`'s audit trail
 * must survive a `make demo` run between the purchase and the export. Created
 * here on first run; an explicit DATABASE_URL is honored as-is.
 */
async function ensureDemoDatabase(): Promise<void> {
  if (process.env.DATABASE_URL !== undefined) {
    return;
  }
  const maintenance = new globalThis.URL(DEFAULT_URL);
  const name = maintenance.pathname.slice(1);
  maintenance.pathname = "/postgres";
  const sql = connect({ url: maintenance.toString(), max: 1, connectTimeoutSeconds: 3 });
  try {
    const found = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found.length === 0) {
      await sql.unsafe(`CREATE DATABASE "${name}"`);
      process.stderr.write(`created ${name} — the rehearsal runs in its own database\n`);
    }
  } catch {
    // Postgres unreachable: the reachability probe below already degrades to
    // the six offline scenarios; nothing to add here.
  } finally {
    await sql.end();
  }
}

async function writeUsbArtifacts(): Promise<void> {
  const root = join(process.cwd(), ".countersign");
  mkdirSync(root, { recursive: true });
  const artifacts = await writeDemoExport(root);
  process.stdout.write(
    `\nwrote ${artifacts.bundle}\n      ${artifacts.trust}\n` +
      `verify: ./dist/countersign.mjs verify --bundle ${artifacts.bundle} --trust ${artifacts.trust}\n`,
  );
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  let code = 1;

  try {
    if (offline) {
      const run = await runRehearsal();
      process.stdout.write(formatRehearsal(run));
      code = run.scenarios
        .filter((s) => s.id !== "webhook" && s.id !== "duplicate")
        .every((s) => s.rehearsed)
        ? 0
        : 1;
    } else {
      // The webhook and duplicate rehearsals reset every table first.
      assertSafeToTruncate(URL, "make demo");
      await ensureDemoDatabase();
      const sql = connect({ url: URL, max: 4, connectTimeoutSeconds: 3 });

      // Reachability is probed separately from the rehearsal itself: a judge
      // without postgres should still see six scenarios run rather than an
      // error and nothing else, but a migration or rehearsal failure on a
      // REACHABLE database is a real bug and must not be papered over by
      // quietly going offline.
      let reachable = true;
      try {
        await sql`SELECT 1`;
      } catch {
        reachable = false;
      }

      if (reachable) {
        try {
          await migrate(sql);
          const run = await runRehearsal({ sql });
          process.stdout.write(formatRehearsal(run));
          code = run.scenarios.every((s) => s.rehearsed) ? 0 : 1;
        } finally {
          await sql.end();
        }
      } else {
        await sql.end();
        process.stderr.write(
          `cannot reach postgres at ${new globalThis.URL(URL).host} — running the six offline scenarios.\n` +
            `webhook and duplicate need a database: run \`make up\` for all eight.\n\n`,
        );
        const run = await runRehearsal();
        process.stdout.write(formatRehearsal(run));
        code = run.scenarios
          .filter((s) => s.id !== "webhook" && s.id !== "duplicate")
          .every((s) => s.rehearsed)
          ? 0
          : 1;
      }
    }
  } finally {
    await writeUsbArtifacts();
  }

  process.exit(code);
}

await main();
