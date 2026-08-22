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
  return new Uint8Array(Buffer.from(encoded, "base64url"));
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
