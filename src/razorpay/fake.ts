/**
 * An in-memory Razorpay.
 *
 * Exists so the outbox, in_doubt path and reconciliation can be tested against
 * the same outcomes the live client produces — a timeout, a duplicate receipt,
 * an order that landed after we gave up — without a network.
 */

import { randomBytes } from "node:crypto";
import {
  type CreateOrderInput,
  type Razorpay,
  RazorpayAlreadyCaptured,
  RazorpayApiError,
  RazorpayDuplicateReceipt,
  type RazorpayOrder,
  type RazorpayPayment,
  RazorpayTimeout,
  type TimeWindow,
} from "./client.js";

export interface FakeRazorpay extends Razorpay {
  readonly orders: Map<string, RazorpayOrder>;
  readonly payments: Map<string, RazorpayPayment>;
  /** Next `createOrder` throws {@link RazorpayTimeout} and, optionally, still lands. */
  timeoutNextCreate(lands: boolean): void;
  timeoutNextCapture(): void;
  failNextCreate(status: number, detail: string): void;
}

export function fakeRazorpay(): FakeRazorpay {
  const orders = new Map<string, RazorpayOrder>();
  const payments = new Map<string, RazorpayPayment>();

  // Ids are unique across processes, not just within one: a persistent dev
  // database keeps yesterday's order_fake_1, and payments.order_id is
  // unique, so a counter restarting at 1 would wedge the worker.
  const instance = randomBytes(3).toString("hex");
  let orderSeq = 0;
  let createTimeout: "drop" | "land" | undefined;
  let captureTimeout = false;
  let createFailure: { status: number; detail: string } | undefined;

  const putOrder = (
    input: CreateOrderInput,
    createdAt = Math.floor(Date.now() / 1000),
  ): RazorpayOrder => {
    const existing = [...orders.values()].find((o) => o.receipt === input.receipt);
    if (existing !== undefined) throw new RazorpayDuplicateReceipt(input.receipt);

    orderSeq += 1;
    const order: RazorpayOrder = {
      id: `order_fake_${instance}_${orderSeq}`,
      amountMinor: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      status: "created",
      createdAt,
    };
    orders.set(order.id, order);
    return order;
  };

  return {
    orders,
    payments,

    timeoutNextCreate(lands) {
      createTimeout = lands ? "land" : "drop";
    },

    timeoutNextCapture() {
      captureTimeout = true;
    },

    failNextCreate(status, detail) {
      createFailure = { status, detail };
    },

    async createOrder(input) {
      if (createFailure !== undefined) {
        const failure = createFailure;
        createFailure = undefined;
        throw new RazorpayApiError(failure.status, "POST /orders", failure.detail);
      }

      if (createTimeout !== undefined) {
        const mode = createTimeout;
        createTimeout = undefined;
        if (mode === "land") putOrder(input);
        throw new RazorpayTimeout("POST /orders");
      }

      return putOrder(input);
    },

    async fetchOrder(orderId) {
      const order = orders.get(orderId);
      if (order === undefined) {
        throw new RazorpayApiError(404, "GET /orders/:id", "order not found");
      }
      return order;
    },

    async findOrderByReceipt(receipt) {
      return [...orders.values()].find((o) => o.receipt === receipt);
    },

    async fetchPayment(paymentId) {
      const payment = payments.get(paymentId);
      if (payment === undefined) {
        throw new RazorpayApiError(404, "GET /payments/:id", "payment not found");
      }
      return payment;
    },

    async listOrders(window: TimeWindow) {
      return [...orders.values()].filter(
        (o) => o.createdAt >= window.from && o.createdAt <= window.to,
      );
    },

    async listPayments(window: TimeWindow) {
      return [...payments.values()].filter(
        (p) => p.createdAt >= window.from && p.createdAt <= window.to,
      );
    },

    async capture(paymentId, amountMinor, currency) {
      if (captureTimeout) {
        captureTimeout = false;
        throw new RazorpayTimeout("POST /payments/:id/capture");
      }

      const existing = payments.get(paymentId);
      if (existing === undefined) {
        throw new RazorpayApiError(404, "POST /payments/:id/capture", "payment not found");
      }
      // A reclaimed capture message re-captures; the real API answers 400.
      if (existing.status === "captured") {
        throw new RazorpayAlreadyCaptured(paymentId);
      }

      const captured: RazorpayPayment = {
        ...existing,
        amountMinor,
        currency,
        status: "captured",
      };
      payments.set(paymentId, captured);

      const order = orders.get(existing.orderId);
      if (order !== undefined) orders.set(order.id, { ...order, status: "paid" });

      return captured;
    },
  };
}

/** Record a payment the way Checkout would, so capture and reconcile have something to find. */
export function seedPayment(
  fake: FakeRazorpay,
  orderId: string,
  overrides: Partial<RazorpayPayment> = {},
): RazorpayPayment {
  const order = fake.orders.get(orderId);
  if (order === undefined) throw new Error(`no fake order ${orderId}`);

  const payment: RazorpayPayment = {
    id: `pay_fake_${fake.payments.size + 1}`,
    orderId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    status: "authorized",
    feeMinor: 0n,
    createdAt: order.createdAt,
    ...overrides,
  };
  fake.payments.set(payment.id, payment);
  return payment;
}
