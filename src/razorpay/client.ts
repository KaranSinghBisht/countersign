/**
 * The Razorpay HTTP surface we actually call.
 *
 * Narrow on purpose. The official SDK wraps the same REST endpoints and then
 * some, and every extra method is a way to create an order without going
 * through the receipt we derived. Keeping the client to these six calls means
 * every outbound request is one we have a reason to make.
 *
 * Timeouts are a first-class outcome, not an error we paper over. A timed-out
 * `orders.create` may have created the order; treating it as a failure and
 * retrying with a fresh receipt is exactly how one purchase becomes two.
 */

import { z } from "zod";

export class RazorpayTimeout extends Error {
  override readonly name = "RazorpayTimeout";
  constructor(readonly method: string) {
    super(`${method} timed out; the request may have landed`);
  }
}

export class RazorpayDuplicateReceipt extends Error {
  override readonly name = "RazorpayDuplicateReceipt";
  constructor(readonly receipt: string) {
    super(`Razorpay already has an order with receipt ${receipt}`);
  }
}

/**
 * Razorpay refused a capture because the payment is already captured. Not a
 * failure: the money moved. A worker that died after `capture()` succeeded but
 * before it recorded the result reclaims the message and re-captures; this is
 * how the second attempt learns it already happened.
 */
export class RazorpayAlreadyCaptured extends Error {
  override readonly name = "RazorpayAlreadyCaptured";
  constructor(readonly paymentId: string) {
    super(`payment ${paymentId} is already captured`);
  }
}

export class RazorpayApiError extends Error {
  override readonly name = "RazorpayApiError";
  constructor(
    readonly status: number,
    readonly method: string,
    detail: string,
  ) {
    super(`${method} returned ${status}: ${detail}`);
  }
}

export interface CreateOrderInput {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly receipt: string;
  readonly notes?: Readonly<Record<string, string>>;
}

export interface RazorpayOrder {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly receipt: string;
  readonly status: string;
  readonly createdAt: number;
}

export interface RazorpayPayment {
  readonly id: string;
  readonly orderId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: string;
  readonly feeMinor: bigint;
  readonly createdAt: number;
}

export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * What the rest of the system talks to.
 *
 * Implemented by {@link liveRazorpay} against the real API and by a fake in
 * tests. The interface is the whole point of the split: a timeout, a duplicate
 * receipt and a captured payment have to be exercisable without a network.
 */
export interface Razorpay {
  createOrder(input: CreateOrderInput): Promise<RazorpayOrder>;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
  findOrderByReceipt(receipt: string): Promise<RazorpayOrder | undefined>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
  listOrders(window: TimeWindow): Promise<RazorpayOrder[]>;
  listPayments(window: TimeWindow): Promise<RazorpayPayment[]>;
  capture(paymentId: string, amountMinor: bigint, currency: string): Promise<RazorpayPayment>;
}

const OrderSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  receipt: z.string().min(1),
  status: z.string().min(1),
  created_at: z.number().int(),
});

const PaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: z.string().min(1),
  // Razorpay sends fee: null until a payment is captured — a literal null,
  // not an absent field. Seen in production on the first live sweep.
  fee: z.number().int().nonnegative().nullable().optional(),
  created_at: z.number().int(),
});

const CollectionSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item).default([]), count: z.number().optional() });

const PAGE = 100;
const MAX_LISTED = 10_000;

async function listPages<T>(page: (skip: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  let skip = 0;
  for (;;) {
    const items = await page(skip);
    all.push(...items);
    if (items.length < PAGE) return all;
    skip += items.length;
    if (skip >= MAX_LISTED) return all;
  }
}

export interface LiveOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function liveRazorpay(options: LiveOptions): Razorpay {
  const base = options.baseUrl ?? "https://api.razorpay.com/v1";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: auth,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(extraHeaders ?? {}),
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await fetchImpl(`${base}${path}`, init);
    } catch (error) {
      if (isAbort(error)) throw new RazorpayTimeout(`${method} ${path}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);

    if (response.status === 400 && isDuplicateReceipt(parsed)) {
      throw new RazorpayDuplicateReceipt(receiptOf(parsed) ?? "");
    }

    if (!response.ok) {
      throw new RazorpayApiError(response.status, `${method} ${path}`, summarise(parsed, text));
    }

    return parsed;
  };

  return {
    async createOrder(input) {
      if (input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`order amount ${input.amountMinor} exceeds what JSON can carry`);
      }

      const raw = await request(
        "POST",
        "/orders",
        {
          amount: Number(input.amountMinor),
          currency: input.currency,
          receipt: input.receipt,
          payment_capture: 0,
          notes: input.notes ?? {},
        },
        { "Idempotency-Key": input.receipt },
      );
      return asOrder(raw);
    },

    async fetchOrder(orderId) {
      return asOrder(await request("GET", `/orders/${encodeURIComponent(orderId)}`));
    },

    async findOrderByReceipt(receipt) {
      const raw = await request("GET", `/orders?receipt=${encodeURIComponent(receipt)}&count=1`);
      const items = CollectionSchema(OrderSchema).parse(raw).items;
      const match = items.find((item) => item.receipt === receipt);
      return match === undefined ? undefined : asOrder(match);
    },

    async fetchPayment(paymentId) {
      return asPayment(await request("GET", `/payments/${encodeURIComponent(paymentId)}`));
    },

    async listOrders(window) {
      return listPages((skip) =>
        request("GET", `/orders?from=${window.from}&to=${window.to}&count=100&skip=${skip}`).then(
          (raw) => CollectionSchema(OrderSchema).parse(raw).items.map(asOrder),
        ),
      );
    },

    async listPayments(window) {
      return listPages((skip) =>
        request("GET", `/payments?from=${window.from}&to=${window.to}&count=100&skip=${skip}`).then(
          (raw) => CollectionSchema(PaymentSchema).parse(raw).items.map(asPayment),
        ),
      );
    },

    async capture(paymentId, amountMinor, currency) {
      if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`capture amount ${amountMinor} exceeds what JSON can carry`);
      }

      try {
        return asPayment(
          await request("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, {
            amount: Number(amountMinor),
            currency,
          }),
        );
      } catch (error) {
        if (
          error instanceof RazorpayApiError &&
          error.status === 400 &&
          /already.*captured/i.test(error.message)
        ) {
          throw new RazorpayAlreadyCaptured(paymentId);
        }
        throw error;
      }
    },
  };
}

function asOrder(raw: unknown): RazorpayOrder {
  const parsed = OrderSchema.parse(raw);
  return {
    id: parsed.id,
    amountMinor: BigInt(parsed.amount),
    currency: parsed.currency,
    receipt: parsed.receipt,
    status: parsed.status,
    createdAt: parsed.created_at,
  };
}

function asPayment(raw: unknown): RazorpayPayment {
  const parsed = PaymentSchema.parse(raw);
  return {
    id: parsed.id,
    orderId: parsed.order_id,
    amountMinor: BigInt(parsed.amount),
    currency: parsed.currency,
    status: parsed.status,
    feeMinor: BigInt(parsed.fee ?? 0),
    createdAt: parsed.created_at,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isDuplicateReceipt(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const error = (parsed as { error?: { description?: unknown } }).error;
  const description = typeof error?.description === "string" ? error.description : "";
  return /receipt.*(already|exist|unique)/i.test(description);
}

function receiptOf(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const error = (parsed as { error?: { metadata?: { receipt?: unknown } } }).error;
  return typeof error?.metadata?.receipt === "string" ? error.metadata.receipt : undefined;
}

function summarise(parsed: unknown, text: string): string {
  if (typeof parsed === "object" && parsed !== null) {
    const error = (parsed as { error?: { description?: unknown } }).error;
    if (typeof error?.description === "string") return error.description;
  }
  return text.slice(0, 200);
}
