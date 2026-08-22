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

import { z } from "zod";
import type { Sql } from "../db/client.js";
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
  if (createdAt !== undefined) {
    const age = input.now - createdAt;

    if (age > STALENESS_WINDOW_SECONDS) {
      return {
        status: 400,
        outcome: "stale",
        detail: `event is ${age}s old, beyond the ${STALENESS_WINDOW_SECONDS}s window`,
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

  try {
    await sql`
			INSERT INTO webhook_events (event_id, event, payment_id, order_id, raw_body, signature)
			VALUES (
				${input.eventId}, ${envelope.event},
				${payment?.id ?? null}, ${payment?.order_id ?? order?.id ?? null},
				${Buffer.from(input.rawBody)}, ${input.signature}
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
    results.push(await processOne(sql, row));
  }

  return results;
}

async function processOne(
  sql: Sql,
  row: { event_id: string; event: string; payment_id: string | null; order_id: string | null },
): Promise<ProcessedEvent> {
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
  if (row.payment_id === null) return settle(false, "event carries no payment id");

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
    return settle(false, `no local payment for ${row.payment_id}`);
  }

  const before = (
    await sql<{ state: string }[]>`SELECT state FROM payments WHERE order_id = ${orderId}`
  )[0];
  if (before === undefined) return settle(false, `no local payment for ${row.payment_id}`);
  if (!isPaymentState(before.state)) {
    return settle(false, `local payment is in unknown state ${before.state}`);
  }

  const result = await applyRemoteState(sql, orderId, row.payment_id, target);
  const transition = advance(before.state, target);
  const contradictory = isContradictory(before.state, target);

  if (!result.applied) return settle(false, transition.reason);

  return settle(
    true,
    contradictory
      ? `${before.state} → ${result.next} (refund with no local capture)`
      : `${before.state} → ${result.next}`,
  );
}
