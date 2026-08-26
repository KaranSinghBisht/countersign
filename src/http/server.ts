/**
 * Process entry point.
 *
 * Config is parsed before anything else starts listening, so a missing
 * webhook secret is a refused boot rather than a silent outage on the first
 * delivery.
 */

import { config, decodeEnvJwk } from "../config.js";
import { importPrivateKey, importPublicKey, publicPartOf } from "../crypto/keys.js";
import { connect } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { liveRazorpay } from "../razorpay/client.js";
import { logger } from "../telemetry/logger.js";
import { buildApp } from "./app.js";
import { startWorkers } from "./worker.js";

const cfg = config();
const sql = connect({ url: cfg.DATABASE_URL, max: cfg.DATABASE_POOL_MAX });

await migrate(sql);

const issuer = await importPublicKey(publicPartOf(decodeEnvJwk(cfg.MANDATE_ISSUER_JWK)), "ES256");
const checkpointKey = await importPrivateKey(decodeEnvJwk(cfg.CHECKPOINT_JWK), "Ed25519");

const log = logger();
const app = await buildApp({
  sql,
  // Exactly what the app needs — handing over the whole config would leak
  // Razorpay API credentials and private JWKs into a layer that has no
  // business holding them.
  config: {
    RAZORPAY_WEBHOOK_SECRET: cfg.RAZORPAY_WEBHOOK_SECRET,
    WEBHOOK_MAX_AGE_SECONDS: cfg.WEBHOOK_MAX_AGE_SECONDS,
    COUNTERSIGN_BASE_URL: cfg.COUNTERSIGN_BASE_URL,
  },
  issuer,
  audience: cfg.COUNTERSIGN_BASE_URL,
});

const razorpay = liveRazorpay({ keyId: cfg.RAZORPAY_KEY_ID, keySecret: cfg.RAZORPAY_KEY_SECRET });
const stopWorkers = startWorkers(sql, razorpay, log, {
  checkpoint: { origin: cfg.AUDIT_ORIGIN, key: checkpointKey },
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, "shutting down");
  stopWorkers();
  await app.close();
  await sql.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
log.info({ port: cfg.PORT }, "listening");
