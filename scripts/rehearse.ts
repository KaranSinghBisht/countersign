#!/usr/bin/env tsx
/**
 * Eight rehearsed failures. This is the live demo.
 *
 *     make demo
 *     pnpm exec tsx scripts/rehearse.ts
 *     pnpm exec tsx scripts/rehearse.ts --offline   # skip webhook + duplicate
 *
 * Webhook and duplicate need postgres (`make up`). The other six do not.
 * Always writes `.countersign/export` + `.countersign/trust.demo.json` for the USB CLI.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { assertSafeToTruncate } from "../src/db/safety.js";
import { formatRehearsal, runRehearsal } from "../src/demo/rehearse.js";
import { writeDemoExport } from "../src/demo/sample-bundle.js";

const URL =
  process.env.DATABASE_URL ?? "postgres://countersign:countersign@localhost:5432/countersign";

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
