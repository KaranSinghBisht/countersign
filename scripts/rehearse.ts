#!/usr/bin/env tsx
/**
 * Eight rehearsed failures. This is the live demo.
 *
 *     make demo
 *     pnpm exec tsx scripts/rehearse.ts
 *     pnpm exec tsx scripts/rehearse.ts --offline   # skip webhook + duplicate
 *
 * Webhook and duplicate need postgres (`make up`). The other six do not.
 */

import { connect } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { formatRehearsal, runRehearsal } from "../src/demo/rehearse.js";

const URL =
  process.env.DATABASE_URL ?? "postgres://countersign:countersign@localhost:5432/countersign";

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");

  if (offline) {
    const run = await runRehearsal();
    process.stdout.write(formatRehearsal(run));
    process.exit(
      run.scenarios
        .filter((s) => s.id !== "webhook" && s.id !== "duplicate")
        .every((s) => s.rehearsed)
        ? 0
        : 1,
    );
  }

  const sql = connect({ url: URL, max: 4, connectTimeoutSeconds: 3 });
  let code = 1;
  try {
    await migrate(sql);
    const run = await runRehearsal({ sql });
    process.stdout.write(formatRehearsal(run));
    code = run.scenarios.every((s) => s.rehearsed) ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `cannot reach postgres at ${URL}\n${message}\n\nrun: make up\nor:  pnpm exec tsx scripts/rehearse.ts --offline\n`,
    );
  } finally {
    await sql.end();
  }
  process.exit(code);
}

await main();
