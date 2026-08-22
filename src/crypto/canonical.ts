/**
 * Canonical JSON — the hashing surface for the whole system.
 *
 * Every hash in Countersign (record hashes, Merkle leaves, mandate request
 * bindings, JWS payloads) is taken over the RFC 8785 canonical form of an
 * object rather than whatever `JSON.stringify` happened to emit. JCS pins
 * property order, number formatting and string escaping, which is what lets
 * the standalone verifier reproduce our hashes byte for byte.
 *
 * `JSON.stringify` with sorted keys is not a substitute: it leaves number
 * serialization and Unicode ordering unspecified across implementations, and
 * the verifier is a separate program that must agree with us exactly.
 *
 * The RFC 8785 implementation lives in `jcs.ts`. This module adds the type
 * surface and the up-front guards against values that canonicalize lossily.
 */

import { utf8 } from "./encoding.js";
import { JcsError, jcs } from "./jcs.js";

export class CanonicalizationError extends JcsError {
  override readonly name: string = "CanonicalizationError";
}

/**
 * Values JCS can represent. Deliberately excludes `bigint`, `undefined`,
 * `Date` and class instances — see {@link assertCanonicalizable}.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Reject values that canonicalize lossily or not at all.
 *
 * Three silent-corruption modes this exists to prevent:
 *
 *   - `bigint` cannot be serialized to JSON at all. Since all money in this
 *     system is `bigint` paise, forgetting to serialize an amount is the
 *     single most likely mistake here, so it gets a pointed error.
 *   - `undefined` properties are silently *dropped*. An audit record with an
 *     accidentally-undefined field would hash as though the field never
 *     existed, and the omission would be invisible.
 *   - `Date` and anything else carrying `toJSON()` is silently converted, so
 *     the hashed bytes would not match the object the caller passed.
 *
 * Serialization enforces all of this anyway. This function exists so callers
 * can validate a record *before* committing to it, without keeping the
 * serialized output.
 */
export function assertCanonicalizable(value: unknown): void {
  canonical(value as JsonValue);
}

/** Canonical JSON text. Throws rather than silently altering the value. */
export function canonical(value: JsonValue): string {
  try {
    return jcs(value);
  } catch (cause) {
    throw new CanonicalizationError((cause as Error).message, { cause });
  }
}

/** Canonical JSON as UTF-8 bytes. This is what gets hashed and signed. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8(canonical(value));
}
