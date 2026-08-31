/**
 * Process entry point.
 *
 * Config is parsed before anything else starts listening, so a missing
 * webhook secret is a refused boot rather than a silent outage on the first
 * delivery. Everything that can go wrong at the process level — a rejection
 * nobody caught, a database that is not up yet, a shutdown that hangs — ends
 * in a logged exit, never in a half-alive process the platform keeps routing
 * traffic to.
 */

import { config, decodeEnvJwk, isProduction } from "../config.js";
import { importPrivateKey, importPublicKey, publicPartOf } from "../crypto/keys.js";
import { connect } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { liveRazorpay } from "../razorpay/client.js";
import { fakeRazorpay } from "../razorpay/fake.js";
import { logger } from "../telemetry/logger.js";
import { buildApp } from "./app.js";
import { startWorkers } from "./worker.js";

const cfg = config();
const log = logger();

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled rejection");
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  log.error({ err: error }, "uncaught exception");
  process.exit(1);
});

const sql = connect({ url: cfg.DATABASE_URL, max: cfg.DATABASE_POOL_MAX });

try {
  await migrate(sql);
} catch (error) {
  // The platform restarts us; a clear line beats a stack trace crash loop.
  log.error({ err: error }, "migrations failed — is the database reachable?");
  await sql.end().catch(() => undefined);
  process.exit(1);
}

const issuer = await importPublicKey(publicPartOf(decodeEnvJwk(cfg.MANDATE_ISSUER_JWK)), "ES256");
const checkpointKey = await importPrivateKey(decodeEnvJwk(cfg.CHECKPOINT_JWK), "Ed25519");

const app = await buildApp({
  sql,
  // Exactly what the app needs — handing over the whole config would leak
  // the private JWKs into a layer that has no business holding them. The
  // key secret is here because the payer page's callback verifies Razorpay's
  // payment signature with it; the key id is public and goes into that page.
  config: {
    RAZORPAY_WEBHOOK_SECRET: cfg.RAZORPAY_WEBHOOK_SECRET,
    WEBHOOK_MAX_AGE_SECONDS: cfg.WEBHOOK_MAX_AGE_SECONDS,
    COUNTERSIGN_BASE_URL: cfg.COUNTERSIGN_BASE_URL,
    RAZORPAY_KEY_ID: cfg.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: cfg.RAZORPAY_KEY_SECRET,
    RAZORPAY_MODE: cfg.RAZORPAY_MODE,
  },
  issuer,
  audience: cfg.COUNTERSIGN_BASE_URL,
});

if (cfg.RAZORPAY_MODE === "fake" && isProduction(cfg)) {
  log.error("RAZORPAY_MODE=fake is refused in production");
  await sql.end().catch(() => undefined);
  process.exit(1);
}
if (cfg.RAZORPAY_MODE === "fake") {
  log.warn("RAZORPAY_MODE=fake: orders are created in memory, nothing reaches Razorpay");
}
const razorpay =
  cfg.RAZORPAY_MODE === "fake"
    ? fakeRazorpay()
    : liveRazorpay({ keyId: cfg.RAZORPAY_KEY_ID, keySecret: cfg.RAZORPAY_KEY_SECRET });
const stopWorkers = startWorkers(sql, razorpay, log, {
  checkpoint: { origin: cfg.AUDIT_ORIGIN, key: checkpointKey },
});

/** Milliseconds a graceful shutdown may take before the process gives up. */
const SHUTDOWN_DEADLINE_MS = 10_000;

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  // A second signal while the first is still draining is not a new request.
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");

  // A drain that hangs — a stuck Razorpay call, a pool that will not close —
  // must not hold the deploy hostage; the platform would SIGKILL anyway.
  const deadline = setTimeout(() => {
    log.error({ signal }, "shutdown deadline passed; exiting");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();

  try {
    await stopWorkers();
    await app.close();
    await sql.end();
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
log.info({ port: cfg.PORT }, "listening");
