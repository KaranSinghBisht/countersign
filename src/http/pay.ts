/**
 * The payer routes.
 *
 *   GET  /pay/r/:receipt          302 to the order's page once the worker has
 *                                 created the order; 202 while it has not
 *   GET  /pay/:order_id           the payer page (Razorpay Checkout, test mode)
 *   POST /pay/:order_id/complete  Checkout's callback: verify the payment
 *                                 signature with the key secret, record it,
 *                                 queue the capture
 *
 * The callback is a convenience, not the authority: the webhook still
 * arrives, and both paths queue the same capture message by payment id.
 * Refused outright unless the live rail with a test-mode key is configured —
 * a fake order cannot be paid, and there is nothing to pay in the tests.
 */

import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import { captureAuthorized } from "../razorpay/capture.js";
import { attachSignature } from "../razorpay/settle.js";
import { PAY_PAGE_CSP, renderPayPage } from "./pages/pay.js";

export interface PayDeps {
  readonly sql: Sql;
  readonly config: Partial<
    Pick<Config, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET" | "RAZORPAY_MODE">
  >;
}

const ORDER_ID = /^order_[A-Za-z0-9_-]{1,64}$/;
const RECEIPT = /^[A-Za-z0-9_-]{1,80}$/;

const CompleteBodySchema = z
  .object({
    razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{1,64}$/),
    razorpay_order_id: z.string().regex(ORDER_ID),
    razorpay_signature: z.string().regex(/^[0-9a-fA-F]{64}$/),
  })
  .strict();

interface PaymentRow {
  readonly receipt: string;
  readonly order_id: string | null;
  readonly amount_minor: bigint;
  readonly currency: string;
  readonly state: string;
}

async function byOrder(sql: Sql, orderId: string): Promise<PaymentRow | undefined> {
  const rows = await sql<PaymentRow[]>`
		SELECT receipt, order_id, amount_minor, currency, state FROM payments WHERE order_id = ${orderId}
	`;
  return rows[0];
}

export async function registerPay(app: FastifyInstance, deps: PayDeps): Promise<void> {
  const keyId = deps.config.RAZORPAY_KEY_ID;
  const keySecret = deps.config.RAZORPAY_KEY_SECRET;
  const live =
    deps.config.RAZORPAY_MODE !== "fake" && keyId !== undefined && keySecret !== undefined;

  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: 60, timeWindow: "1 minute" });

    scope.get<{ Params: { receipt: string } }>("/pay/r/:receipt", async (request, reply) => {
      if (!RECEIPT.test(request.params.receipt)) {
        return reply.code(400).send({ error: "malformed receipt" });
      }
      const rows = await deps.sql<{ order_id: string | null }[]>`
				SELECT order_id FROM payments WHERE receipt = ${request.params.receipt}
			`;
      const row = rows[0];
      if (row === undefined) return reply.code(404).send({ error: "no payment for that receipt" });
      if (row.order_id === null) {
        return reply
          .code(202)
          .send({ status: "pending", detail: "the worker has not created the order yet" });
      }
      return reply.redirect(`/pay/${encodeURIComponent(row.order_id)}`, 302);
    });

    scope.get<{ Params: { order_id: string } }>("/pay/:order_id", async (request, reply) => {
      if (!ORDER_ID.test(request.params.order_id)) {
        return reply.code(400).send({ error: "malformed order id" });
      }
      if (!live) {
        return reply.code(503).send({
          outcome: "unavailable",
          detail: "the live rail is not configured; nothing to pay",
        });
      }
      const row = await byOrder(deps.sql, request.params.order_id);
      if (row === undefined) return reply.code(404).send({ error: "no such order here" });
      return reply
        .header("content-security-policy", PAY_PAGE_CSP)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(
          renderPayPage({
            keyId: keyId as string,
            orderId: request.params.order_id,
            receipt: row.receipt,
            amountMinor: row.amount_minor,
            currency: row.currency,
            state: row.state,
          }),
        );
    });

    scope.post<{ Params: { order_id: string } }>(
      "/pay/:order_id/complete",
      { bodyLimit: 2048 },
      async (request, reply) => {
        if (!ORDER_ID.test(request.params.order_id)) {
          return reply
            .code(400)
            .send({ outcome: "rejected", at: "schema", detail: "malformed order id" });
        }
        if (!live) {
          return reply
            .code(503)
            .send({ outcome: "unavailable", detail: "the live rail is not configured" });
        }
        const parsed = CompleteBodySchema.safeParse(request.body);
        if (!parsed.success || parsed.data.razorpay_order_id !== request.params.order_id) {
          return reply
            .code(400)
            .send({ outcome: "rejected", at: "schema", detail: "malformed callback" });
        }
        const row = await byOrder(deps.sql, request.params.order_id);
        if (row === undefined)
          return reply
            .code(404)
            .send({ outcome: "rejected", at: "order", detail: "no such order" });

        const { razorpay_payment_id: paymentId, razorpay_signature: signature } = parsed.data;
        const verified = await attachSignature(
          deps.sql,
          request.params.order_id,
          paymentId,
          signature,
          keySecret as string,
        );
        if (!verified) {
          return reply.code(400).send({
            outcome: "rejected",
            at: "signature",
            detail: "Razorpay's signature does not verify",
          });
        }
        const queued = await captureAuthorized(deps.sql, request.params.order_id, paymentId);
        return {
          outcome: "paid",
          order_id: request.params.order_id,
          payment_id: paymentId,
          signature_verified: true,
          capture: queued ? "queued" : "already_queued",
        };
      },
    );
  });
}
