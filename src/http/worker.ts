/**
 * Outbox drain, webhook application, and checkpoint publishing. Not started
 * by `buildApp`, so tests that inject HTTP stay free of a live Razorpay
 * client.
 */

import { latestCheckpoint, publishCheckpoint, size } from "../audit/log.js";
import type { KeyPair } from "../crypto/keys.js";
import type { Sql } from "../db/client.js";
import type { Razorpay } from "../razorpay/client.js";
import { purgeDone } from "../razorpay/outbox.js";
import { drain } from "../razorpay/settle.js";
import { processPending, purgeProcessedEvents } from "../razorpay/webhook.js";
import { purgeExpired } from "../spend/nonce.js";
import type { Logger } from "../telemetry/logger.js";
import { purgeSettled, reapExpiredLeases } from "./idempotency.js";

/** Housekeeping runs once per this many ticks — roughly once a minute. */
const HOUSEKEEPING_EVERY = 30;

export interface WorkerOptions {
  readonly intervalMs?: number;
  /**
   * When present, a checkpoint is signed and published every time the log
   * has grown. Without this the audit trail exists but nobody has committed
   * to it — `GET /audit/checkpoint` would 404 forever and a bundle exported
   * later would have no signed root to verify against.
   */
  readonly checkpoint?: {
    readonly origin: string;
    readonly key: KeyPair;
  };
}

export function startWorkers(
  sql: Sql,
  razorpay: Razorpay,
  log: Logger,
  options: WorkerOptions = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 2_000;
  let stopped = false;
  let running = false;
  let ticks = 0;
  let current: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      // A message that ends failed or in doubt is a payment that will not
      // settle on its own. Seventy-four refused orders once produced zero
      // log lines; an operator has to be able to see this happen.
      for (const result of await drain(sql, razorpay)) {
        if (result.outcome === "failed" || result.outcome === "in_doubt") {
          log.warn(
            {
              outbox_id: result.id,
              kind: result.kind,
              outcome: result.outcome,
              detail: result.detail,
            },
            "outbox message did not settle",
          );
        }
      }
      await processPending(sql);
      if (options.checkpoint !== undefined) {
        await publishIfGrown(sql, options.checkpoint, log);
      }
      // /nonce and /purchase are unauthenticated; without periodic reaping,
      // expired nonces and settled idempotency keys accumulate one row per
      // request forever — a storage DoS that costs the caller nothing.
      if (ticks % HOUSEKEEPING_EVERY === 0) {
        const nonces = await purgeExpired(sql);
        const leases = await reapExpiredLeases(sql);
        const settled = await purgeSettled(sql);
        // Raw webhook bodies and finished outbox rows are operational
        // residue, not evidence — the audit log and mandate artifacts are
        // what is kept forever. Without a retention bound both grow one row
        // per event for the life of the deployment.
        const events = await purgeProcessedEvents(sql);
        const outboxDone = await purgeDone(sql);
        if (nonces + leases + settled + events + outboxDone > 0) {
          log.info(
            { nonces, leases, settled, events, outbox_done: outboxDone },
            "housekeeping purged rows",
          );
        }
      }
    } catch (error) {
      log.error({ err: error }, "worker tick failed");
    } finally {
      // Counted in finally: a tick that throws before this line would
      // otherwise pin the counter and re-run housekeeping every tick.
      ticks += 1;
      running = false;
    }
  };

  const run = (): Promise<void> => {
    current = tick();
    return current;
  };
  const timer = setInterval(() => void run(), intervalMs);
  void run();

  // Stopping waits for the tick in progress. Closing the pool underneath a
  // running Razorpay call would leave its outbox row in_flight until the
  // lease lapsed — recoverable now, but a wait costs nothing and a deploy
  // should not depend on the recovery path.
  return async () => {
    stopped = true;
    clearInterval(timer);
    await current;
  };
}

/**
 * Publish a checkpoint if the log has records the latest one does not cover.
 *
 * Safe under concurrent workers: Ed25519 is deterministic, so two publishers
 * at the same size produce byte-identical notes and `publishCheckpoint`'s
 * ON CONFLICT path accepts the duplicate. A DIFFERENT note at the same size
 * is a fork and throws, which is exactly what should page someone.
 */
async function publishIfGrown(
  sql: Sql,
  checkpoint: NonNullable<WorkerOptions["checkpoint"]>,
  log: Logger,
): Promise<void> {
  const n = await size(sql);
  if (n === 0) return;

  const latest = await latestCheckpoint(sql);
  if (latest !== undefined && latest.checkpoint.size >= n) return;

  const published = await publishCheckpoint(
    sql,
    checkpoint.origin,
    checkpoint.origin,
    checkpoint.key,
  );
  log.info({ size: published.checkpoint.size }, "audit checkpoint published");
}
