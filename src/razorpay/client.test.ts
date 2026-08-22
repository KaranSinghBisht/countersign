import { describe, expect, it } from "vitest";
import {
  liveRazorpay,
  type RazorpayApiError,
  RazorpayDuplicateReceipt,
  RazorpayTimeout,
} from "./client.js";

const KEY = "rzp_test_xxxxxxxxxxxxxx";
const SECRET = "replace_me_at_least_16";

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("live Razorpay client", () => {
  it("creates an order and maps minor units to bigint", async () => {
    const razorpay = liveRazorpay({
      keyId: KEY,
      keySecret: SECRET,
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.razorpay.com/v1/orders");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          amount: 1499,
          currency: "INR",
          receipt: "prTEST",
          payment_capture: 0,
        });
        return respond(200, {
          id: "order_abc",
          amount: 1499,
          currency: "INR",
          receipt: "prTEST",
          status: "created",
          created_at: 1_755_700_500,
        });
      },
    });

    const order = await razorpay.createOrder({
      amountMinor: 1499n,
      currency: "INR",
      receipt: "prTEST",
    });

    expect(order).toMatchObject({ id: "order_abc", amountMinor: 1499n, receipt: "prTEST" });
  });

  it("turns a hung request into RazorpayTimeout", async () => {
    const razorpay = liveRazorpay({
      keyId: KEY,
      keySecret: SECRET,
      timeoutMs: 20,
      fetch: async (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });

    await expect(
      razorpay.createOrder({ amountMinor: 100n, currency: "INR", receipt: "prX" }),
    ).rejects.toBeInstanceOf(RazorpayTimeout);
  });

  it("surfaces a duplicate receipt instead of a generic 400", async () => {
    const razorpay = liveRazorpay({
      keyId: KEY,
      keySecret: SECRET,
      fetch: async () =>
        respond(400, {
          error: {
            description: "Receipt already exists",
            metadata: { receipt: "prDUP" },
          },
        }),
    });

    await expect(
      razorpay.createOrder({ amountMinor: 100n, currency: "INR", receipt: "prDUP" }),
    ).rejects.toBeInstanceOf(RazorpayDuplicateReceipt);
  });

  it("surfaces other API errors with the status", async () => {
    const razorpay = liveRazorpay({
      keyId: KEY,
      keySecret: SECRET,
      fetch: async () => respond(401, { error: { description: "authentication failed" } }),
    });

    await expect(razorpay.fetchOrder("order_x")).rejects.toMatchObject({
      name: "RazorpayApiError",
      status: 401,
    } satisfies Partial<RazorpayApiError>);
  });

  it("sends basic auth derived from the key pair", async () => {
    let authorization = "";

    const razorpay = liveRazorpay({
      keyId: KEY,
      keySecret: SECRET,
      fetch: async (_input, init) => {
        const headers = init?.headers;
        authorization =
          headers === undefined || headers instanceof Headers
            ? ""
            : String((headers as Record<string, string>).Authorization ?? "");
        return respond(200, { items: [], count: 0 });
      },
    });

    await razorpay.listOrders({ from: 1, to: 2 });

    expect(authorization).toBe(`Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`);
  });
});
