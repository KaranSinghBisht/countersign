/**
 * base64url without padding, per RFC 7515 Appendix C.
 *
 * Every hash, signature and proof that crosses a wire or lands in the audit
 * log uses this encoding. Padded base64 would still decode, but it would make
 * two encodings of the same bytes possible, and anything that can be encoded
 * two ways will eventually be hashed two ways.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(input: string): Uint8Array {
  return textEncoder.encode(input);
}

export function fromUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function b64uDecode(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
    throw new Error("not valid base64url: contains padding or non-alphabet characters");
  }

  const decoded = new Uint8Array(Buffer.from(encoded, "base64url"));

  // Reject non-canonical trailing bits.
  //
  // The final base64url character does not always carry a full 6 bits of
  // payload — a 64-byte Ed25519 signature encodes to 86 characters, of which
  // the last contributes only 4. Decoders ignore the surplus bits, so
  // "...AA" and "...AB" decode to identical bytes. That makes the encoding
  // malleable: an attacker can produce a different-looking token that
  // verifies, and any dedupe or replay guard keyed on the encoded string
  // sees two distinct values for one signature.
  //
  // Re-encoding and comparing is the cheapest way to insist that one byte
  // string has exactly one representation.
  if (b64u(decoded) !== encoded) {
    throw new Error(
      "not canonical base64url: trailing bits are non-zero, so these bytes have " +
        "more than one encoding",
    );
  }

  return decoded;
}

/**
 * Standard base64, padded.
 *
 * Distinct from `b64u` and used only for transparency-dev signed notes, whose
 * format predates the base64url convention and specifies this alphabet. Mixing
 * the two up produces notes that other implementations of the format cannot
 * read, which is the one thing adopting an existing format was meant to avoid.
 */
export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function b64Decode(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("not valid base64: contains non-alphabet characters");
  }

  const decoded = new Uint8Array(Buffer.from(encoded, "base64"));

  // Same canonicality insistence as b64uDecode: one byte string, one encoding.
  // Without it a checkpoint could be re-encoded into a different string that
  // still verifies, and anything keyed on the note text sees two logs.
  if (b64(decoded) !== encoded) {
    throw new Error("not canonical base64: these bytes have more than one encoding");
  }

  return decoded;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexDecode(encoded: string): Uint8Array {
  if (encoded.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(encoded)) {
    throw new Error("not valid hex");
  }
  return new Uint8Array(Buffer.from(encoded, "hex"));
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time byte comparison.
 *
 * Used for every signature and HMAC check. A plain `===` on the encoded form
 * leaks the position of the first differing byte through timing, which is
 * enough to forge a signature one byte at a time.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}
