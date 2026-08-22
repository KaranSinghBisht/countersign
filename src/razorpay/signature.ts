/**
 * Razorpay HMAC signature verification.
 *
 * Two different signatures, over two different things, with two different
 * secrets — conflating them is a real and easy mistake:
 *
 *   payment  HMAC-SHA256("<order_id>|<payment_id>", KEY_SECRET)
 *   webhook  HMAC-SHA256(<raw request body>, WEBHOOK_SECRET)
 *
 * The webhook signature covers the RAW BODY. Not a re-serialised object, not
 * `JSON.stringify(req.body)` — the exact bytes that arrived. A global JSON
 * parser mounted above the webhook route is the single most common cause of
 * "signature mismatch" reports against every payment provider, because by the
 * time the handler runs the original bytes are gone and re-encoding them
 * changes key order, whitespace and unicode escaping.
 */

import { createHmac } from "node:crypto";
import { hex, hexDecode, timingSafeEqual, utf8 } from "../crypto/encoding.js";

/** SHA-256 hex is always 64 characters. */
const HEX_SIGNATURE_LENGTH = 64;

function hmac(payload: Uint8Array, secret: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(payload).digest());
}

/**
 * Compare a received hex signature against one we computed.
 *
 * Length is checked before the comparison, and the check is on the DECODED
 * bytes. Comparing hex strings directly would leak length through the string
 * comparison and would treat "AB" and "ab" as different signatures over
 * identical bytes.
 */
function matches(received: string, expected: Uint8Array): boolean {
  if (received.length !== HEX_SIGNATURE_LENGTH) return false;

  let decoded: Uint8Array;
  try {
    decoded = hexDecode(received);
  } catch {
    return false;
  }

  return timingSafeEqual(decoded, expected);
}

/**
 * Verify the signature returned by Checkout alongside a successful payment.
 *
 * This is an *externally attested* fact and worth storing as one: it is
 * Razorpay asserting, under a secret only they and we hold, that this payment
 * belongs to this order. Our own records cannot manufacture it.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  // The separator is part of the signed string, so an order id containing a
  // pipe could otherwise shift the boundary. Razorpay ids do not, but relying
  // on that is relying on someone else's id format never changing.
  if (orderId.includes("|") || paymentId.includes("|")) return false;

  return matches(signature, hmac(utf8(`${orderId}|${paymentId}`), keySecret));
}

/**
 * Verify a webhook signature over the raw request body.
 *
 * `rawBody` must be the bytes as received. Accepting `Uint8Array` rather than
 * `string` is deliberate: it makes it awkward to pass a re-serialised object by
 * accident, which is the failure this function exists to prevent.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  webhookSecret: string,
): boolean {
  return matches(signature, hmac(rawBody, webhookSecret));
}

/** Sign like Razorpay would. Test-only; nothing in the server signs as Razorpay. */
export function signAsRazorpay(payload: Uint8Array | string, secret: string): string {
  return hex(hmac(typeof payload === "string" ? utf8(payload) : payload, secret));
}
