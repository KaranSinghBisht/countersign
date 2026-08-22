/**
 * Reconciliation: Razorpay is the authority, we are the one who can be wrong.
 *
 * Pull a window of orders and payments from the PSP, match them against local
 * rows, and classify every disagreement. Classification is the whole job —
 * a typed exception list is what an operator can act on, and a boolean
 * "everything is fine" is what hides the one that is not.
 *
 * Fixes, when they happen, are new balanced ledger transactions. An UPDATE
 * on an existing entry would make the log lie about the past.
 */

import type { Sql } from "../db/client.js";
import type { CurrencyCode } from "../money/money.js";
import type { Razorpay, RazorpayOrder, RazorpayPayment, TimeWindow } from "./client.js";
import { applyRemoteState } from "./settle.js";
import { isPaymentState, type PaymentState } from "./state.js";

export const EXCEPTION_KINDS = [
  "MISSING_AT_PSP",
  "MISSING_LOCALLY",
  "STATE_MISMATCH",
  "AMOUNT_MISMATCH",
  "IN_DOUBT_UNRESOLVED",
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export interface Exception {
  readonly kind: ExceptionKind;
  readonly receipt: string;
  readonly orderId?: string;
  readonly paymentId?: string;
  readonly localState?: string;
  readonly remoteState?: string;
  readonly localAmount?: string;
  readonly remoteAmount?: string;
  readonly detail: string;
}

export interface ReconcileReport {
  readonly window: TimeWindow;
  readonly local: number;
  readonly remote: number;
  readonly matched: number;
  readonly exceptions: readonly Exception[];
}

interface LocalPayment {
  receipt: string;
  order_id: string | null;
  payment_id: string | null;
  amount_minor: bigint;
  currency: CurrencyCode;
  state: string;
  in_doubt: boolean;
  in_doubt_reason: string | null;
}

const REMOTE_STATE: Record<string, PaymentState> = {
  created: "created",
  attempted: "created",
  authorized: "authorized",
  captured: "captured",
  paid: "captured",
  failed: "failed",
  refunded: "refunded",
};

export async function reconcile(
  sql: Sql,
  razorpay: Razorpay,
  window: TimeWindow,
): Promise<ReconcileReport> {
  const local = await sql<LocalPayment[]>`
		SELECT receipt, order_id, payment_id, amount_minor, currency, state, in_doubt, in_doubt_reason
		  FROM payments
		 WHERE created_at >= to_timestamp(${window.from})
		   AND created_at <= to_timestamp(${window.to})
	`;

  const remoteOrders = await razorpay.listOrders(window);
  const remotePayments = await razorpay.listPayments(window);

  const byReceipt = new Map<string, RazorpayOrder>();
  const byOrderId = new Map<string, RazorpayOrder>();
  for (const order of remoteOrders) {
    byReceipt.set(order.receipt, order);
    byOrderId.set(order.id, order);
  }

  const paymentsByOrder = new Map<string, RazorpayPayment[]>();
  for (const payment of remotePayments) {
    const list = paymentsByOrder.get(payment.orderId) ?? [];
    list.push(payment);
    paymentsByOrder.set(payment.orderId, list);
  }

  const exceptions: Exception[] = [];
  const seenRemote = new Set<string>();

  for (const row of local) {
    const remote =
      (row.order_id !== null ? byOrderId.get(row.order_id) : undefined) ??
      byReceipt.get(row.receipt);

    if (remote === undefined) {
      if (row.in_doubt) {
        exceptions.push({
          kind: "IN_DOUBT_UNRESOLVED",
          receipt: row.receipt,
          localState: row.state,
          detail: row.in_doubt_reason ?? "timed out talking to Razorpay; still unresolved",
        });
        continue;
      }

      exceptions.push({
        kind: "MISSING_AT_PSP",
        receipt: row.receipt,
        ...(row.order_id === null ? {} : { orderId: row.order_id }),
        localState: row.state,
        localAmount: row.amount_minor.toString(),
        detail: `local payment ${row.receipt} has no matching Razorpay order`,
      });
      continue;
    }

    seenRemote.add(remote.id);

    if (remote.amountMinor !== row.amount_minor || remote.currency !== row.currency) {
      exceptions.push({
        kind: "AMOUNT_MISMATCH",
        receipt: row.receipt,
        orderId: remote.id,
        localAmount: `${row.amount_minor} ${row.currency}`,
        remoteAmount: `${remote.amountMinor} ${remote.currency}`,
        detail: `local ${row.amount_minor} ${row.currency} vs Razorpay ${remote.amountMinor} ${remote.currency}`,
      });
    }

    const remotePaymentsForOrder = paymentsByOrder.get(remote.id) ?? [];
    const leading = leadingPayment(remotePaymentsForOrder);
    const remoteState = leading !== undefined ? mapState(leading.status) : mapState(remote.status);

    if (remoteState !== undefined && remoteState !== row.state) {
      exceptions.push({
        kind: "STATE_MISMATCH",
        receipt: row.receipt,
        orderId: remote.id,
        ...(leading === undefined ? {} : { paymentId: leading.id }),
        localState: row.state,
        remoteState,
        detail: `local is ${row.state}, Razorpay is ${remoteState}`,
      });
    }
  }

  for (const order of remoteOrders) {
    if (seenRemote.has(order.id)) continue;

    const locally = local.find((row) => row.receipt === order.receipt || row.order_id === order.id);
    if (locally !== undefined) continue;

    exceptions.push({
      kind: "MISSING_LOCALLY",
      receipt: order.receipt,
      orderId: order.id,
      remoteState: order.status,
      remoteAmount: order.amountMinor.toString(),
      detail: `Razorpay order ${order.id} has no local payment`,
    });
  }

  return {
    window,
    local: local.length,
    remote: remoteOrders.length,
    matched: seenRemote.size,
    exceptions,
  };
}

/**
 * Adopt Razorpay's view of every STATE_MISMATCH, by the same rank rule the
 * webhook uses.
 *
 * Amount mismatches and missing rows are not auto-fixed: inventing a local
 * payment for a PSP order we never intended, or rewriting an amount, is how
 * reconciliation becomes a second, quieter writer. Those stay on the list.
 */
export async function adoptRemoteState(
  sql: Sql,
  razorpay: Razorpay,
  report: ReconcileReport,
): Promise<number> {
  let adopted = 0;

  for (const exception of report.exceptions) {
    if (exception.kind !== "STATE_MISMATCH") continue;
    if (exception.orderId === undefined || exception.remoteState === undefined) continue;
    if (!isPaymentState(exception.remoteState)) continue;

    const paymentId =
      exception.paymentId ?? (await firstPaymentId(razorpay, exception.orderId)) ?? "unknown";

    const result = await applyRemoteState(sql, exception.orderId, paymentId, exception.remoteState);
    if (result.applied) adopted += 1;
  }

  return adopted;
}

function leadingPayment(payments: readonly RazorpayPayment[]): RazorpayPayment | undefined {
  const rank = (status: string): number => {
    if (status === "refunded") return 5;
    if (status === "captured") return 4;
    if (status === "authorized") return 3;
    if (status === "failed") return 2;
    return 1;
  };

  return [...payments].sort((a, b) => rank(b.status) - rank(a.status))[0];
}

function mapState(status: string): PaymentState | undefined {
  return REMOTE_STATE[status];
}

async function firstPaymentId(razorpay: Razorpay, orderId: string): Promise<string | undefined> {
  const order = await razorpay.fetchOrder(orderId).catch(() => undefined);
  if (order === undefined) return undefined;
  const payments = await razorpay.listPayments({
    from: order.createdAt,
    to: order.createdAt + 86_400,
  });
  return payments.find((p) => p.orderId === orderId)?.id;
}
