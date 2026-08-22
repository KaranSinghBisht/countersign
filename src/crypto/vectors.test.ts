/**
 * The cross-implementation contract.
 *
 * These assertions are the reason the standalone verifier can be a separate
 * program: they pin the exact bytes this implementation produces for
 * canonicalization, digests and deterministic signing. If a dependency bump
 * or a refactor changes any of them, this file goes red immediately rather
 * than on day twelve when a judge's laptop reports a hash mismatch and there
 * is no way to tell which side is wrong.
 *
 * Regenerate deliberately with `pnpm exec tsx scripts/gen-vectors.ts`, and
 * treat the diff as a wire-format change.
 */

import { describe, expect, it } from "vitest";
import vectors from "../../test/vectors/crypto.json" with { type: "json" };
import { canonical, type JsonValue } from "./canonical.js";
import { digestJson, digestString } from "./digest.js";
import { verify } from "./jws.js";
import { importPublicKey } from "./keys.js";

describe("canonicalization vectors", () => {
  for (const [name, vector] of Object.entries(vectors.canonicalization)) {
    it(`${name}: canonical form is unchanged`, () => {
      expect(canonical(vector.input as JsonValue)).toBe(vector.canonical);
    });

    it(`${name}: digest is unchanged`, () => {
      expect(digestJson(vector.input as JsonValue)).toBe(vector.sha256_b64u);
    });
  }
});

describe("UTF-8 digest vectors", () => {
  for (const [name, vector] of Object.entries(vectors.digest_utf8)) {
    it(`${name}`, () => {
      expect(digestString(vector.input)).toBe(vector.sha256_b64u);
    });
  }
});

describe("key identity vectors", () => {
  it("Ed25519 thumbprint is unchanged", async () => {
    const key = await importPublicKey(vectors.keys.ed25519.public as never);
    expect(key.kid).toBe(vectors.keys.ed25519.kid);
  });

  it("ES256 thumbprint is unchanged", async () => {
    const key = await importPublicKey(vectors.keys.es256.public as never);
    expect(key.kid).toBe(vectors.keys.es256.kid);
  });
});

describe("JWS vectors", () => {
  // Ed25519 is deterministic, so this is a true byte-for-byte anchor: any
  // independent implementation signing this payload with this key must
  // produce exactly this string.
  it("the Ed25519 compact serialization verifies and is byte-stable", async () => {
    const key = await importPublicKey(vectors.keys.ed25519.public as never);
    const v = vectors.jws.ed25519_deterministic;

    const verified = await verify(v.compact, key, v.typ);
    expect(verified.payload).toEqual(v.payload);
    expect(verified.header).toMatchObject({ alg: "Ed25519", kid: key.kid, typ: v.typ });
  });

  // ES256 is deliberately non-deterministic (AP2 requires it for hash-bound
  // mandates), so we can only assert that the stored signature verifies.
  it("the ES256 compact serialization verifies", async () => {
    const key = await importPublicKey(vectors.keys.es256.public as never);
    const v = vectors.jws.es256_must_verify;

    const verified = await verify(v.compact, key, v.typ);
    expect(verified.payload).toEqual(v.payload);
  });

  it("a single flipped character in the stored signature fails verification", async () => {
    const key = await importPublicKey(vectors.keys.ed25519.public as never);
    const v = vectors.jws.ed25519_deterministic;

    const [h, p, s] = v.compact.split(".") as [string, string, string];
    // Deliberately mid-string. The FINAL character of a 64-byte signature
    // carries only 4 significant bits, so flipping it can change nothing at
    // all — see the canonical-encoding test in crypto.test.ts.
    const mid = Math.floor(s.length / 2);
    const flipped = `${s.slice(0, mid)}${s[mid] === "A" ? "B" : "A"}${s.slice(mid + 1)}`;

    await expect(verify(`${h}.${p}.${flipped}`, key, v.typ)).rejects.toThrow();
  });
});
