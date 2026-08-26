/**
 * Webhook ingestion.
 *
 * Razorpay times out at 5 seconds and retries; a full day of failures
 * auto-disables the webhook. So the request path does the least possible work —
 * verify, dedupe, store, acknowledge — and everything else happens later.
 * "Process it now while we have it" is how a slow database turns into a
 * disabled webhook and a silent outage.
 *
 * Four things are easy to get wrong here and all four are deliberate:
 *
 *   - the signature covers the RAW BODY, so the bytes must reach this code
 *     unparsed;
 *   - dedupe is an INSERT that may conflict, never a SELECT then an INSERT,
 *     because two retries can arrive at once;
 *   - the staleness window is 26 hours, not 5 minutes — Razorpay's retry
 *     schedule runs for a day, and copying Stripe's number rejects legitimate
 *     retries;
 *   - events are recorded whether or not they change anything.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sql, TransactionSql } from "../db/client.js";
import { isUniqueViolation } from "../db/client.js";
import { applyRemoteState } from "./settle.js";
import { verifyWebhookSignature } from "./signature.js";
import { advance, isContradictory, isPaymentState, type PaymentState } from "./state.js";

/**
 * How old a signed event may be before we refuse it.
 *
 * 26 hours, covering Razorpay's retry schedule with room to spare. Stripe's
 * 5-minute tolerance is widely copied and wrong here: a retry of a legitimate
 * event that we failed to acknowledge yesterday must still be accepted, or the
 * retry mechanism cannot do its job.
 */
export const STALENESS_WINDOW_SECONDS = 26 * 60 * 60;

/** Tolerance for a webhook timestamp slightly ahead of our clock. */
const FUTURE_SKEW_SECONDS = 5 * 60;

const EntitySchema = z
  .object({
    id: z.string().optional(),
    order_id: z.string().nullish(),
    status: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    /** PSP fee in minor units; present on payment.captured payloads. */
    fee: z.number().optional(),
  })
  .loose();

export const WebhookEnvelopeSchema = z
  .object({
    event: z.string().min(1),
    created_at: z.number().int().positive().optional(),
    payload: z
      .object({
        payment: z.object({ entity: EntitySchema }).optional(),
        order: z.object({ entity: EntitySchema }).optional(),
        refund: z.object({ entity: EntitySchema }).optional(),
      })
      .loose(),
  })
  .loose();

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

export type IngestResult =
  | { readonly status: 200; readonly outcome: "accepted"; readonly eventId: string }
  | { readonly status: 200; readonly outcome: "duplicate"; readonly eventId: string }
  | { readonly status: 400; readonly outcome: "malformed"; readonly detail: string }
  | { readonly status: 401; readonly outcome: "bad_signature" }
  | { readonly status: 400; readonly outcome: "stale"; readonly detail: string };

export interface IngestInput {
  readonly rawBody: Uint8Array;
  readonly signature: string | undefined;
  readonly eventId: string | undefined;
  readonly secret: string;
  /** Seconds since the epoch. Injected so staleness is testable. */
  readonly now: number;
  /** Override the 26-hour default. Operators set WEBHOOK_MAX_AGE_SECONDS. */
  readonly maxAgeSeconds?: number;
}

/**
 * Accept an event: verify, dedupe, store, return.
 *
 * Deliberately does NOT apply the event. Applying it means touching payments,
 * the ledger and the audit log, and none of that belongs inside a five-second
 * budget shared with Razorpay's network latency.
 */
export async function ingest(sql: Sql, input: IngestInput): Promise<IngestResult> {
  if (input.signature === undefined || input.signature.length === 0) {
    return { status: 401, outcome: "bad_signature" };
  }

  // Signature first, before parsing. Nothing in an unauthenticated body
  // deserves to reach a parser, and rejecting cheaply keeps a flood of forged
  // events from costing anything.
  if (!verifyWebhookSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, outcome: "bad_signature" };
  }

  if (input.eventId === undefined || input.eventId.length === 0) {
    return { status: 400, outcome: "malformed", detail: "missing x-razorpay-event-id" };
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = WebhookEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(input.rawBody)));
  } catch (error) {
    return {
      status: 400,
      outcome: "malformed",
      detail: error instanceof Error ? error.message : "unparseable body",
    };
  }

  const createdAt = envelope.created_at;
  const maxAge = input.maxAgeSeconds ?? STALENESS_WINDOW_SECONDS;
  if (createdAt !== undefined) {
    const age = input.now - createdAt;

    if (age > maxAge) {
      return {
        status: 400,
        outcome: "stale",
        detail: `event is ${age}s old, beyond the ${maxAge}s window`,
      };
    }

    // Far enough in the future to indicate a forged or misconfigured
    // sender rather than ordinary clock drift.
    if (age < -FUTURE_SKEW_SECONDS) {
      return {
        status: 400,
        outcome: "stale",
        detail: `event is timestamped ${-age}s in the future`,
      };
    }
  }

  const payment = envelope.payload.payment?.entity;
  const order = envelope.payload.order?.entity;

  // Dedupe on the SIGNED bytes, not just the event-id header. The header
  // rides outside the signature, so a captured body could be replayed with
  // fresh ids forever — every copy verifying, every copy a new row.
  const bodySha256 = createHash("sha256").update(input.rawBody).digest("hex");

  try {
    await sql`
			INSERT INTO webhook_events (event_id, event, payment_id, order_id, raw_body, signature, body_sha256)
			VALUES (
				${input.eventId}, ${envelope.event},
				${payment?.id ?? null}, ${payment?.order_id ?? order?.id ?? null},
				${Buffer.from(input.rawBody)}, ${input.signature}, ${bodySha256}
			)
		`;
  } catch (error) {
    // The insert IS the dedupe. A SELECT-then-INSERT lets two concurrent
    // retries both find nothing and both proceed.
    if (isUniqueViolation(error)) {
      return { status: 200, outcome: "duplicate", eventId: input.eventId };
    }
    throw error;
  }

  return { status: 200, outcome: "accepted", eventId: input.eventId };
}

// ---------------------------------------------------------------------------
// Deferred processing
// ---------------------------------------------------------------------------

/** Razorpay event names mapped to the state they imply. */
const EVENT_STATES: Record<string, PaymentState> = {
  "payment.authorized": "authorized",
  "payment.captured": "captured",
  "payment.failed": "failed",
  "refund.created": "refunded",
  "refund.processed": "refunded",
  "order.paid": "captured",
};

export interface ProcessedEvent {
  readonly eventId: string;
  readonly applied: boolean;
  readonly outcome: string;
}

/**
 * Apply the events accepted so far.
 *
 * Runs outside the request path. Each event is processed in its own
 * transaction so one poisonous event cannot block the rest, and an event that
 * changes nothing is still marked processed — otherwise it is retried forever.
 */
export async function processPending(sql: Sql, limit = 100): Promise<ProcessedEvent[]> {
  const pending = await sql<
    { event_id: string; event: string; payment_id: string | null; order_id: string | null }[]
  >`
		SELECT event_id, event, payment_id, order_id
		  FROM webhook_events
		 WHERE processed_at IS NULL
		 ORDER BY received_at
		 LIMIT ${limit}
	`;

  const results: ProcessedEvent[] = [];

  for (const row of pending) {
    const processed = await sql.begin(async (tx) => {
      const locked = await tx<PendingRow[]>`
				SELECT event_id, event, payment_id, order_id, raw_body
				  FROM webhook_events
				 WHERE event_id = ${row.event_id}
				   AND processed_at IS NULL
				 FOR UPDATE SKIP LOCKED
			`;
      const claimed = locked[0];
      if (claimed === undefined) return undefined;
      return processOne(tx, claimed);
    });
    if (processed !== undefined) results.push(processed);
  }

  return results;
}

interface PendingRow {
  event_id: string;
  event: string;
  payment_id: string | null;
  order_id: string | null;
  raw_body: Uint8Array;
}

async function processOne(sql: Sql | TransactionSql, row: PendingRow): Promise<ProcessedEvent> {
  const target = EVENT_STATES[row.event];

  const settle = async (applied: boolean, outcome: string): Promise<ProcessedEvent> => {
    await sql`
			UPDATE webhook_events
			   SET processed_at = now(), applied = ${applied}, outcome = ${outcome}
			 WHERE event_id = ${row.event_id}
		`;
    return { eventId: row.event_id, applied, outcome };
  };

  // An event we do not model is still an event we received. Marking it
  // processed with an explanation beats retrying it until the end of time.
  if (target === undefined) return settle(false, `unhandled event type ${row.event}`);
  if (row.payment_id === null && !(row.event === "order.paid" && row.order_id !== null)) {
    return settle(false, "event carries no payment id");
  }

  // Prefer order_id: that is our local join key from the moment create_order
  // returns. payment_id is only known after Checkout, so an event that arrives
  // with just a payment id still has to find us by that.
  const orderId =
    row.order_id ??
    (
      await sql<{ order_id: string | null }[]>`
				SELECT order_id FROM payments WHERE payment_id = ${row.payment_id}
			`
    )[0]?.order_id;

  if (orderId === null || orderId === undefined) {
    return unmatched(sql, row, settle);
  }

  const before = (
    await sql<{ state: string }[]>`SELECT state FROM payments WHERE order_id = ${orderId}`
  )[0];
  if (before === undefined) return unmatched(sql, row, settle);
  if (!isPaymentState(before.state)) {
    return settle(false, `local payment is in unknown state ${before.state}`);
  }

  const paymentId =
    row.payment_id ??
    (
      await sql<{ payment_id: string | null }[]>`
				SELECT payment_id FROM payments WHERE order_id = ${orderId}
			`
    )[0]?.payment_id;
  if (paymentId === null || paymentId === undefined) {
    return unmatched(sql, row, settle);
  }

  // The PSP fee rides inside the SIGNED payload. Using it here matters when
  // this webhook beats our own capture-API response: the ledger post id for
  // the capture goes to whoever applies first, and a capture posted with fee
  // 0 loses the fee expense forever — the later, fee-bearing post collides
  // and is swallowed as a duplicate.
  const feeMinor = target === "captured" ? feeFrom(row.raw_body) : 0n;

  const result = await applyRemoteState(sql, orderId, paymentId, target, feeMinor);
  const transition = advance(before.state, target);
  const contradictory = isContradictory(before.state, target);

  if (!result.applied) {
    // `advance` would happily report "created → refunded" for the refused
    // contradictory pair, which reads as if it were applied. Say what
    // actually happened instead.
    return settle(
      false,
      contradictory
        ? `refused ${target}: refund with no local capture (payment is ${before.state})`
        : transition.reason,
    );
  }

  return settle(true, `${before.state} → ${result.next}`);
}

function feeFrom(rawBody: Uint8Array): bigint {
  try {
    const envelope = WebhookEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(rawBody)));
    const fee = envelope.payload.payment?.entity.fee;
    return typeof fee === "number" && Number.isSafeInteger(fee) && fee >= 0 ? BigInt(fee) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * A miss is either a stranger (Razorpay has a payment we never intended —
 * mark processed, reconciliation owns it) or a race: we have a local row
 * whose `order_id` is still null because `rememberOrder` has not committed.
 * Marking that race processed is a poison pill. Leave it pending.
 */
async function unmatched(
  sql: Sql | TransactionSql,
  row: { event_id: string; payment_id: string | null },
  settle: (applied: boolean, outcome: string) => Promise<ProcessedEvent>,
): Promise<ProcessedEvent> {
  const inflight = await sql`
		SELECT 1 FROM payments
		 WHERE order_id IS NULL
		   AND state IN ('created', 'authorized')
		 LIMIT 1
	`;
  if (inflight.length > 0) {
    // Waiting is only worth it while the race can still resolve. The queue
    // is oldest-first with a LIMIT, so one permanently stuck payment plus a
    // backlog of stranger events would starve everything behind them; after
    // an hour the race explanation is no longer credible.
    const young = await sql`
			SELECT 1 FROM webhook_events
			 WHERE event_id = ${row.event_id}
			   AND received_at > now() - interval '1 hour'
		`;
    if (young.length > 0) {
      return {
        eventId: row.event_id,
        applied: false,
        outcome: `no local payment for ${row.payment_id} (waiting for order_id)`,
      };
    }
    return settle(false, `no local payment for ${row.payment_id}; gave up waiting for order_id`);
  }
  return settle(false, `no local payment for ${row.payment_id}`);
}
