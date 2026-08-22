/**
 * Deterministic receipt derivation.
 *
 *   receipt = "pr" + base32(SHA256(domain ‖ closed_jti ‖ request_hash))[:38]
 *
 * Razorpay caps `receipt` at 40 characters, so "pr" plus 38 base32 characters
 * uses the field exactly. 38 characters of base32 is 190 bits, which is far
 * more collision resistance than a payment reference needs.
 *
 * The value of deriving it rather than generating one is that a retry of the
 * same purchase produces the same receipt. With unique-receipt enforcement
 * turned on at Razorpay, a genuine duplicate is then rejected by Razorpay
 * itself — a second line of defence that holds even if our own idempotency
 * logic has a bug. Defence in depth matters most exactly where a bug means
 * charging someone twice.
 *
 * Crockford's base32 rather than hex because hex would need 76 characters to
 * carry the same digest and would not fit, and rather than base64 because the
 * field should survive being read aloud, logged, and pasted into a support
 * ticket.
 */

import { digest } from "../crypto/digest.js";
import { utf8 } from "../crypto/encoding.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const RECEIPT_PREFIX = "pr";
const RECEIPT_BODY_LENGTH = 38;

/** Razorpay's hard limit on the field. */
export const RECEIPT_MAX_LENGTH = 40;

/**
 * Domain separation.
 *
 * Without it, this digest could collide with any other SHA-256 we compute over
 * the same inputs elsewhere in the system, and a value meant as a receipt could
 * be repurposed as something else.
 */
const DOMAIN = "countersign/receipt/v1\n";

export function deriveReceipt(closedJti: string, requestHash: string): string {
  if (closedJti.length === 0) throw new Error("closed_jti is required to derive a receipt");
  if (requestHash.length === 0) throw new Error("request_hash is required to derive a receipt");

  // Length-prefixed rather than plainly concatenated. Both inputs are fixed
  // width today (a 26-character ULID and a 43-character digest), so plain
  // concatenation is unambiguous — but only by accident. If either ever
  // changes length, ("ab", "c") and ("a", "bc") would derive the same
  // receipt for different purchases.
  const material = utf8(
    `${DOMAIN}${closedJti.length}:${closedJti}\n${requestHash.length}:${requestHash}`,
  );

  return RECEIPT_PREFIX + base32(digest(material)).slice(0, RECEIPT_BODY_LENGTH);
}

/** Crockford base32, no padding. */
function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  // Left-align the remaining bits, matching how a decoder would read them.
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 0x1f];

  return out;
}

const RECEIPT_PATTERN = new RegExp(`^${RECEIPT_PREFIX}[0-9A-HJKMNP-TV-Z]{${RECEIPT_BODY_LENGTH}}$`);

/**
 * Whether a string could have been produced by `deriveReceipt`.
 *
 * Shape only. It says nothing about which purchase the receipt belongs to —
 * that requires rederiving it from the mandate and the request, which is what
 * the verifier does.
 */
export function isWellFormedReceipt(receipt: string): boolean {
  return RECEIPT_PATTERN.test(receipt);
}
