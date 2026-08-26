/**
 * Outbox drain, webhook application, and checkpoint publishing. Not started
 * by `buildApp`, so tests that inject HTTP stay free of a live Razorpay
 * client.
 */

import { latestCheckpoint, publishCheckpoint, size } from "../audit/log.js";
import type { KeyPair } from "../crypto/keys.js";
import type { Sql } from "../db/client.js";
import type { Razorpay } from "../razorpay/client.js";
import { drain } from "../razorpay/settle.js";
import { processPending } from "../razorpay/webhook.js";
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
): () => void {
  const intervalMs = options.intervalMs ?? 2_000;
  let stopped = false;
  let running = false;
  let ticks = 0;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await drain(sql, razorpay);
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
        if (nonces + leases + settled > 0) {
          log.info({ nonces, leases, settled }, "housekeeping purged rows");
        }
      }
      ticks += 1;
    } catch (error) {
      log.error({ err: error }, "worker tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
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
