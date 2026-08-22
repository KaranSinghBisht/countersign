/**
 * Apply pending migrations.
 *
 * Reads DATABASE_URL directly rather than going through the full config
 * validator, so migrations can run in contexts (CI, a fresh container) where
 * the Razorpay credentials the server requires are not present and not needed.
 */

import { connect } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = connect({ url });

try {
  const result = await migrate(sql);

  if (result.applied.length === 0) {
    console.log(`schema is current (${result.alreadyCurrent} migration(s) already applied)`);
  } else {
    for (const name of result.applied) console.log(`applied ${name}`);
  }
} catch (error) {
  console.error(`migration failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
