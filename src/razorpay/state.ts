/**
 * Payment lifecycle, and what to do with out-of-order events.
 *
 * Razorpay explicitly does not guarantee that `payment.authorized` is
 * delivered before `payment.captured`. Webhooks are at-least-once and
 * unordered, so an implementation that simply assigns the incoming status will
 * eventually walk a captured payment backwards to authorized and, if anything
 * downstream keys off that, re-capture it.
 *
 * The fix is a rank. An event is always RECORDED; it only moves the state when
 * it outranks what we already have. Recording an event we do not apply matters
 * as much as applying one — it is the evidence that we saw it and chose not to
 * regress, which is exactly the question reconciliation asks later.
 *
 * The ordering is by how much we would regret ignoring the event, which is
 * mostly "did money move":
 *
 *   created    nothing has happened yet
 *   authorized funds are held, not taken
 *   failed     terminal, no money moved
 *   captured   money moved — outranks failed on purpose
 *   refunded   money moved back, and can only follow a capture
 *
 * `failed` sitting below `captured` is the load-bearing choice. If Razorpay
 * tells us a payment was captured, money moved, and that is true regardless of
 * an earlier failure event arriving late. Believing the money-moved event is
 * the safe direction: the alternative is a captured payment recorded as failed,
 * which reconciliation would report as MISSING_LOCALLY while the customer has
 * genuinely been charged.
 */

export const PAYMENT_STATES = ["created", "authorized", "failed", "captured", "refunded"] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

const RANK: Record<PaymentState, number> = {
  created: 10,
  authorized: 20,
  failed: 30,
  captured: 40,
  refunded: 50,
};

export function rankOf(state: PaymentState): number {
  return RANK[state];
}

export function isPaymentState(value: string): value is PaymentState {
  return (PAYMENT_STATES as readonly string[]).includes(value);
}

export interface Transition {
  readonly next: PaymentState;
  readonly applied: boolean;
  readonly reason: string;
}

/**
 * Decide what a payment's state becomes when an event arrives.
 *
 * Pure, so the interesting cases can be tested without a database or a
 * webhook, and so reconciliation can replay the same decision offline.
 */
export function advance(current: PaymentState, incoming: PaymentState): Transition {
  if (incoming === current) {
    return { next: current, applied: false, reason: `already ${current}; duplicate delivery` };
  }

  if (RANK[incoming] > RANK[current]) {
    return { next: incoming, applied: true, reason: `${current} → ${incoming}` };
  }

  return {
    next: current,
    applied: false,
    reason:
      `ignoring ${incoming} because the payment is already ${current}; ` +
      `webhooks are unordered and this event arrived late`,
  };
}

/**
 * States from which no further progress is expected.
 *
 * Advisory. A terminal state is not enforced as a dead end, because Razorpay
 * remains the authority — a `captured` arriving after `failed` still wins on
 * rank, and it should.
 */
export function isTerminal(state: PaymentState): boolean {
  return state === "failed" || state === "refunded";
}

/**
 * A `refunded` that never had a capture is contradictory and worth surfacing:
 * either we missed the capture event or the refund is not ours.
 */
export function isContradictory(current: PaymentState, incoming: PaymentState): boolean {
  return incoming === "refunded" && current !== "captured";
}
