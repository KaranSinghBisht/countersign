/**
 * Export the live audit log as a verifiable bundle.
 *
 *   DATABASE_URL=postgres://… pnpm exec tsx scripts/export-bundle.ts [out-dir]
 *
 * Writes to .countersign/live-export by default. Verify it with the same CLI
 * a third party would use:
 *
 *   pnpm exec tsx src/cli/index.ts verify --bundle <out-dir> --trust ./trust.json
 *
 * Reads DATABASE_URL directly rather than the full config validator, so an
 * export can run where Razorpay credentials are absent — evidence extraction
 * needs the database, nothing else.
 */

import { exportLiveBundle } from "../src/audit/export-live.js";
import { connect } from "../src/db/client.js";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const dir = process.argv[2] ?? ".countersign/live-export";
const sql = connect({ url });

try {
  const result = await exportLiveBundle(sql, dir);
  console.log(`exported ${result.records} record(s), sealed at tree size ${result.treeSize}`);
  console.log(`bundle: ${result.dir}`);
} catch (error) {
  console.error(`export failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
