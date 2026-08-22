/**
 * Pinned trust for the verifier.
 *
 * The keys live here, in a file the operator distributes out of band, and
 * nowhere else. A bundle that carries its own `trust.json` is ignored even if
 * it is sitting in the same directory — a verifier that learned its keys from
 * the artifact under inspection would verify nothing at all.
 */

import { readFileSync } from "node:fs";
import type { JWK } from "jose";
import { z } from "zod";
import { importPublicKey, type PublicKeyRef } from "../crypto/keys.js";

export class TrustError extends Error {
  override readonly name = "TrustError";
}

const JwkSchema = z
  .object({
    kty: z.string().min(1),
    alg: z.string().optional(),
    kid: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
  })
  .passthrough()
  .refine((jwk) => jwk.d === undefined, "trust.json must contain PUBLIC keys only");

const KeyEntry = z.object({
  alg: z.enum(["ES256", "Ed25519"]),
  kid: z.string().min(1).optional(),
  jwk: JwkSchema,
  purpose: z.string().optional(),
});

const TrustFileSchema = z
  .object({
    origin: z.string().min(1),
    audience: z.url(),
    checkpoint_key_name: z.string().min(1).optional(),
    keys: z.object({
      MANDATE_ISSUER_JWK: KeyEntry,
      CHECKPOINT_JWK: KeyEntry,
      AGENT_SIGNING_JWK: KeyEntry.optional(),
    }),
  })
  .passthrough();

export interface Trust {
  readonly origin: string;
  readonly audience: string;
  readonly checkpointKeyName: string;
  readonly issuer: PublicKeyRef;
  readonly checkpoint: PublicKeyRef;
}

/**
 * Load trust from a path the CALLER chose.
 *
 * There is no fallback that searches the bundle. That fallback is the bug.
 */
export async function loadTrust(path: string): Promise<Trust> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new TrustError(`cannot read trust file ${path}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TrustError(`trust file is not JSON: ${(error as Error).message}`);
  }

  const result = TrustFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new TrustError(
      `invalid trust file: ${result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const file = result.data;

  try {
    const issuer = await importPublicKey(file.keys.MANDATE_ISSUER_JWK.jwk as JWK, "ES256");
    const checkpoint = await importPublicKey(file.keys.CHECKPOINT_JWK.jwk as JWK, "Ed25519");

    return {
      origin: file.origin,
      audience: file.audience,
      checkpointKeyName: file.checkpoint_key_name ?? file.origin,
      issuer,
      checkpoint,
    };
  } catch (error) {
    throw new TrustError(`trust keys could not be imported: ${(error as Error).message}`);
  }
}
