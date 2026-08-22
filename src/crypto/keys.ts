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
