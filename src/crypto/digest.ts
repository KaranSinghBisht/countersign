/**
 * SHA-256 digests over canonical JSON and raw bytes.
 *
 * `@noble/hashes` rather than `node:crypto` because the verifier is intended
 * to run anywhere — including a browser or a bundled single file — and noble
 * is audited, dependency-free, and identical across runtimes.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { b64u, utf8 } from "./encoding.js";

export function digest(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/** SHA-256 of raw bytes, base64url encoded. */
export function digestB64u(bytes: Uint8Array): string {
  return b64u(digest(bytes));
}

/** SHA-256 of a UTF-8 string, base64url encoded. */
export function digestString(value: string): string {
  return digestB64u(utf8(value));
}

/**
 * SHA-256 over the RFC 8785 canonical form of an object, base64url encoded.
 *
 * This is the hash used for audit record hashes and for binding a mandate to
 * a request. Two structurally equal objects always produce the same digest,
 * regardless of key insertion order.
 */
export function digestJson(value: JsonValue): string {
  return digestB64u(canonicalBytes(value));
}
