/**
 * Signing keys.
 *
 * Two algorithms, deliberately, and the reason they differ is load-bearing:
 *
 *   ES256 (ECDSA P-256) signs mandates. AP2 requires a NON-deterministic
 *   signature on any JWT whose hash is used as a public binding identifier:
 *   "To prevent rainbow table attacks, the Checkout JWT MUST be signed using
 *   a digital signature scheme (e.g., ECDSA) and not a deterministic
 *   signature (e.g., Ed25519)." Cart contents are low-entropy — a merchant
 *   id, a SKU, a price — so with a deterministic signature the whole JWT is a
 *   pure function of a guessable payload, and an attacker can precompute
 *   hashes for plausible carts and learn what was bought from the public
 *   identifier alone. ECDSA's per-signature randomness removes the
 *   precomputation.
 *
 *   Ed25519 signs audit-log checkpoints. There is no low-entropy preimage to
 *   guess there — leaves carry nonces and monotonic sequence numbers — so
 *   determinism is harmless, and Ed25519 is what the transparency-dev
 *   signed-note format uses.
 *
 * @see https://ap2-protocol.org/ap2/specification/
 */

import type { CryptoKey, JWK } from "jose";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from "jose";
import { b64uDecode, concatBytes } from "./encoding.js";

export const SIGNING_ALGORITHMS = ["ES256", "Ed25519"] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

/** What each algorithm is for, so a misuse is a type error and not a subtle bug. */
export const MANDATE_ALG = "ES256" satisfies SigningAlgorithm;
export const CHECKPOINT_ALG = "Ed25519" satisfies SigningAlgorithm;

export class KeyError extends Error {
  override readonly name = "KeyError";
}

export interface KeyPair {
  readonly alg: SigningAlgorithm;
  /** RFC 7638 JWK thumbprint, base64url. Stable across encodings of the same key. */
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly privateJwk: JWK;
}

export interface PublicKeyRef {
  readonly alg: SigningAlgorithm;
  readonly kid: string;
  readonly key: CryptoKey;
  readonly jwk: JWK;
}

function assertSupported(alg: string): asserts alg is SigningAlgorithm {
  if (!(SIGNING_ALGORITHMS as readonly string[]).includes(alg)) {
    throw new KeyError(
      `unsupported algorithm ${alg}; expected one of ${SIGNING_ALGORITHMS.join(", ")}`,
    );
  }
}

export async function generateKey(alg: SigningAlgorithm): Promise<KeyPair> {
  assertSupported(alg);
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });

  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");

  return {
    alg,
    kid,
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, alg, kid },
    privateJwk: { ...privateJwk, alg, kid },
  };
}

/**
 * Import a public key for verification.
 *
 * The verifier resolves keys only from its pinned trust configuration, never
 * from the artifact under inspection — a bundle that supplies its own
 * verification key proves nothing.
 */
export async function importPublicKey(jwk: JWK, alg?: SigningAlgorithm): Promise<PublicKeyRef> {
  const algorithm = alg ?? jwk.alg;
  if (typeof algorithm !== "string") {
    throw new KeyError("JWK has no `alg` and none was supplied");
  }
  assertSupported(algorithm);

  if (jwk.d !== undefined) {
    throw new KeyError("refusing to import a private key as a public key");
  }

  const key = (await importJWK(jwk, algorithm)) as CryptoKey;
  const kid = await calculateJwkThumbprint(jwk, "sha256");

  if (jwk.kid !== undefined && jwk.kid !== kid) {
    throw new KeyError(
      `JWK kid ${jwk.kid} does not match its RFC 7638 thumbprint ${kid}; ` +
        `the key material and its stated identity disagree`,
    );
  }

  return { alg: algorithm, kid, key, jwk };
}

export async function importPrivateKey(jwk: JWK, alg?: SigningAlgorithm): Promise<KeyPair> {
  const algorithm = alg ?? jwk.alg;
  if (typeof algorithm !== "string") {
    throw new KeyError("JWK has no `alg` and none was supplied");
  }
  assertSupported(algorithm);

  if (jwk.d === undefined) {
    throw new KeyError("expected a private key (no `d` parameter present)");
  }

  const privateKey = (await importJWK(jwk, algorithm)) as CryptoKey;
  const publicJwk = publicPartOf(jwk);
  const publicKey = (await importJWK(publicJwk, algorithm)) as CryptoKey;
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");

  return {
    alg: algorithm,
    kid,
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, alg: algorithm, kid },
    privateJwk: jwk,
  };
}

/**
 * Strip private parameters from a JWK.
 *
 * Uses an allow-list rather than deleting known-private fields, so a future
 * JWK parameter cannot leak by default. Anything not explicitly public is
 * dropped.
 */
export function publicPartOf(jwk: JWK): JWK {
  const PUBLIC_PARAMS = ["kty", "crv", "x", "y", "n", "e", "alg", "kid", "use", "key_ops"] as const;
  const out: Record<string, unknown> = {};
  for (const param of PUBLIC_PARAMS) {
    if (jwk[param] !== undefined) out[param] = jwk[param];
  }
  return out as JWK;
}

/** RFC 7638 thumbprint, base64url. Used as `kid` and as the Web Bot Auth key id. */
export async function thumbprint(jwk: JWK): Promise<string> {
  return calculateJwkThumbprint(publicPartOf(jwk), "sha256");
}

/**
 * The raw public key bytes.
 *
 * Ed25519 is the 32-byte `x` parameter; P-256 is the uncompressed SEC1 point,
 * `0x04 ‖ x ‖ y`. Needed for signed-note key hashes, which are computed over
 * key bytes rather than over a JWK — a JWK has many encodings and would give a
 * different key hash depending on how it was serialised.
 */
export function publicKeyBytes(jwk: JWK): Uint8Array {
  if (jwk.kty === "OKP") {
    if (jwk.x === undefined) throw new KeyError("OKP key is missing its x parameter");
    return b64uDecode(jwk.x);
  }

  if (jwk.kty === "EC") {
    if (jwk.x === undefined || jwk.y === undefined) {
      throw new KeyError("EC key is missing its x or y parameter");
    }
    return concatBytes(Uint8Array.of(0x04), b64uDecode(jwk.x), b64uDecode(jwk.y));
  }

  throw new KeyError(`cannot extract raw key bytes from a ${String(jwk.kty)} key`);
}

const RAW_PARAMS = {
  ES256: { name: "ECDSA", hash: "SHA-256" },
  Ed25519: { name: "Ed25519" },
  // The DOM lib is not enabled, so EcdsaParams and Algorithm are unavailable
  // here. This structural constraint is looser but still enforces the part
  // that matters: every signing algorithm must have an entry, so adding one
  // without wiring it up is a compile error rather than a runtime surprise.
} as const satisfies Record<SigningAlgorithm, { readonly name: string; readonly hash?: string }>;

/**
 * Sign raw bytes, with no JWS envelope.
 *
 * Signed notes commit to their own body text, not to a JWS payload, so the
 * signature has to cover exactly those bytes. Routing this through `jws.sign`
 * would sign a base64url-wrapped copy and produce a note nobody else can
 * verify.
 */
export async function signRaw(data: Uint8Array, key: KeyPair): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(RAW_PARAMS[key.alg], key.privateKey, data);
  return new Uint8Array(signature);
}

export async function verifyRaw(
  data: Uint8Array,
  signature: Uint8Array,
  key: PublicKeyRef,
): Promise<boolean> {
  return crypto.subtle.verify(RAW_PARAMS[key.alg], key.key, signature, data);
}
