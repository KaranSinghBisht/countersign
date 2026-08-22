/**
 * Compact JWS signing and verification.
 *
 * Mandates, receipts and checkpoints are all compact JWS. The format is
 * deliberately boring: a payments engineer reads a JWT and moves on, whereas
 * Biscuit's Datalog or a UCAN's IPLD chain buys an explanation.
 *
 * The claim vocabulary is AP2-shaped (`vct`, `cnf`, `iss`/`aud`/`jti`/`exp`),
 * so migrating to SD-JWT later is a serialization change rather than a
 * redesign — SD-JWT is a JWS whose payload carries `_sd` digest arrays plus
 * tilde-separated disclosures.
 */

import { CompactSign, compactVerify } from "jose";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { b64uDecode, fromUtf8 } from "./encoding.js";
import type { KeyPair, PublicKeyRef, SigningAlgorithm } from "./keys.js";

export class JwsError extends Error {
  override readonly name: string = "JwsError";
}

export class SignatureVerificationError extends JwsError {
  override readonly name: string = "SignatureVerificationError";
}

export interface JwsHeader {
  readonly alg: SigningAlgorithm;
  readonly kid: string;
  /** Media type of the payload, so a mandate can never be verified as a receipt. */
  readonly typ: string;
  readonly [key: string]: unknown;
}

export interface VerifiedJws<T extends JsonValue = JsonValue> {
  readonly header: JwsHeader;
  readonly payload: T;
  /** The exact compact serialization that was verified, for hash binding. */
  readonly compact: string;
}

/**
 * Sign a payload as compact JWS.
 *
 * The payload is serialized with RFC 8785 canonical JSON. That is stricter
 * than JWS requires, and it is what makes `hash(jws_bytes)` reproducible by
 * an independent implementation: two signers given the same claims produce
 * byte-identical payload segments.
 */
export async function sign(
  payload: JsonValue,
  key: KeyPair,
  typ: string,
  extraHeader: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  if (typeof typ !== "string" || typ.length === 0) {
    throw new JwsError("a `typ` media type is required so artifacts cannot be confused");
  }
  return new CompactSign(canonicalBytes(payload))
    .setProtectedHeader({ ...extraHeader, alg: key.alg, kid: key.kid, typ })
    .sign(key.privateKey);
}

/**
 * Verify a compact JWS against a specific, already-trusted public key.
 *
 * There is no key-resolution callback and no `jwks_uri` fetch by design. The
 * caller must have decided which key it trusts before calling, which is what
 * stops a token from nominating the key that validates it.
 *
 * `expectedTyp` is checked because a signature proves only that *we* signed
 * *something*; without a type check, a valid open mandate could be presented
 * where a closed mandate is expected.
 */
export async function verify<T extends JsonValue = JsonValue>(
  compact: string,
  key: PublicKeyRef,
  expectedTyp: string,
): Promise<VerifiedJws<T>> {
  let result: Awaited<ReturnType<typeof compactVerify>>;
  try {
    result = await compactVerify(compact, key.key, { algorithms: [key.alg] });
  } catch (cause) {
    throw new SignatureVerificationError(
      `signature does not verify against key ${key.kid}: ${(cause as Error).message}`,
      { cause },
    );
  }

  const header = result.protectedHeader as unknown as JwsHeader;

  if (header.typ !== expectedTyp) {
    throw new SignatureVerificationError(
      `wrong artifact type: expected ${expectedTyp}, got ${String(header.typ)}`,
    );
  }
  if (header.alg !== key.alg) {
    throw new SignatureVerificationError(
      `algorithm mismatch: header says ${String(header.alg)}, key is ${key.alg}`,
    );
  }
  if (header.kid !== undefined && header.kid !== key.kid) {
    throw new SignatureVerificationError(
      `key id mismatch: header says ${String(header.kid)}, verified with ${key.kid}`,
    );
  }

  let payload: T;
  try {
    payload = JSON.parse(fromUtf8(result.payload)) as T;
  } catch (cause) {
    throw new SignatureVerificationError("payload is not valid UTF-8 JSON", { cause });
  }

  return { header, payload, compact };
}

/**
 * Read the header and payload WITHOUT verifying the signature.
 *
 * Only for deciding which key to look up, and for producing a useful error on
 * a malformed artifact. Never branch on a value from here in a way that
 * affects an authorization decision.
 */
export function decodeUnsafe<T extends JsonValue = JsonValue>(
  compact: string,
): { header: JwsHeader; payload: T } {
  const parts = compact.split(".");
  if (parts.length !== 3) {
    throw new JwsError(`not a compact JWS: expected 3 segments, found ${parts.length}`);
  }
  const [headerSeg, payloadSeg] = parts as [string, string, string];
  try {
    return {
      header: JSON.parse(fromUtf8(b64uDecode(headerSeg))) as JwsHeader,
      payload: JSON.parse(fromUtf8(b64uDecode(payloadSeg))) as T,
    };
  } catch (cause) {
    throw new JwsError("compact JWS segments are not valid base64url JSON", { cause });
  }
}
