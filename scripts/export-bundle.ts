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
 * needs the database, nothing else. When CHECKPOINT_JWK and AUDIT_ORIGIN are
 * present it first seals whatever the worker has not yet, so a purchase made
 * a moment ago is in the bundle rather than waiting on the next tick.
 */

import { exportLiveBundle } from "../src/audit/export-live.js";
import { latestCheckpoint, publishCheckpoint, size } from "../src/audit/log.js";
import { decodeEnvJwk } from "../src/config.js";
import { importPrivateKey } from "../src/crypto/keys.js";
import { connect, type Sql } from "../src/db/client.js";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

/** Same rule as the worker: publish only if the log has grown past the last seal. */
async function sealIfGrown(sql: Sql): Promise<void> {
  const jwk = process.env.CHECKPOINT_JWK;
  // Same default as src/config.ts, so a fresh clone that never set AUDIT_ORIGIN
  // still seals with the name the worker uses.
  const origin = process.env.AUDIT_ORIGIN || "countersign.dev/audit";
  if (jwk === undefined || jwk === "") return;

  const n = await size(sql);
  if (n === 0) return;
  const latest = await latestCheckpoint(sql);
  if (latest !== undefined && latest.checkpoint.size >= n) return;

  const key = await importPrivateKey(decodeEnvJwk(jwk), "Ed25519");
  const published = await publishCheckpoint(sql, origin, origin, key);
  console.log(`sealed ${published.checkpoint.size} record(s) before export`);
}

const dir = process.argv[2] ?? ".countersign/live-export";
const sql = connect({ url });

try {
  await sealIfGrown(sql);
  const result = await exportLiveBundle(sql, dir);
  console.log(`exported ${result.records} record(s), sealed at tree size ${result.treeSize}`);
  console.log(`bundle: ${result.dir}`);
} catch (error) {
  console.error(`export failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
