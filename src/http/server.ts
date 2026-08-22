/**
 * Process entry point.
 *
 * Config is parsed before anything else starts listening, so a missing
 * webhook secret is a refused boot rather than a silent outage on the first
 * delivery.
 */

import { config } from "../config.js";
import { connect } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { logger } from "../telemetry/logger.js";
import { buildApp } from "./app.js";

const cfg = config();
const sql = connect({ url: cfg.DATABASE_URL, max: cfg.DATABASE_POOL_MAX });

await migrate(sql);

const log = logger();
const app = await buildApp({ sql, config: cfg });

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down");
  await app.close();
  await sql.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
log.info({ port: cfg.PORT }, "listening");
