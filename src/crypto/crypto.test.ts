import { describe, expect, it } from "vitest";
import { canonical } from "./canonical.js";
import { digestB64u, digestJson, digestString } from "./digest.js";
import { b64u, b64uDecode, concatBytes, hex, timingSafeEqual, utf8 } from "./encoding.js";
import { decodeUnsafe, SignatureVerificationError, sign, verify } from "./jws.js";
import {
  CHECKPOINT_ALG,
  generateKey,
  importPrivateKey,
  importPublicKey,
  KeyError,
  MANDATE_ALG,
  publicPartOf,
  thumbprint,
} from "./keys.js";

const TYP_MANDATE = "application/countersign-mandate+jws";
const TYP_RECEIPT = "application/countersign-receipt+jws";

const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Flip bit 0 of the final base64url character.
 *
 * For any input whose length is not a multiple of 3, bit 0 of the last
 * character is a surplus bit that decoders discard — so this produces a
 * different string that decodes to identical bytes.
 */
function mutateSurplusBits(encoded: string): string {
  const last = encoded.slice(-1);
  const value = B64U_ALPHABET.indexOf(last);
  return encoded.slice(0, -1) + B64U_ALPHABET[value ^ 1];
}

describe("encoding", () => {
  it("produces unpadded base64url", () => {
    expect(b64u(utf8("a"))).toBe("YQ");
    expect(b64u(utf8("ab"))).toBe("YWI");
    expect(b64u(utf8("abc"))).toBe("YWJj");
    expect(b64u(utf8("a"))).not.toContain("=");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(b64uDecode(b64u(bytes))).toEqual(bytes);
  });

  it("rejects padded or non-alphabet input, so one byte string has one encoding", () => {
    expect(() => b64uDecode("YQ==")).toThrow(/base64url/);
    expect(() => b64uDecode("a+b/c")).toThrow(/base64url/);
  });

  // The final character of a base64url string does not always carry a full
  // six bits. "YQ" and "YR" both decode to the single byte 0x61, because the
  // surplus low bits are ignored. Left unchecked, that is malleability: a
  // signature or digest has more than one spelling, and any replay guard or
  // dedupe keyed on the encoded form sees two values for one artifact.
  it("rejects non-canonical trailing bits", () => {
    // "YQ" and "YR" both decode to the single byte 0x61: one byte is 8 bits,
    // two characters carry 12, and the surplus 4 are ignored.
    expect(b64u(b64uDecode("YQ"))).toBe("YQ");
    expect(() => b64uDecode("YR")).toThrow(/canonical/);

    // Same defect at signature scale. A 64-byte Ed25519 signature is 512
    // bits; 86 characters carry 516, so the last character's low 4 bits are
    // surplus. Flip bit 0 — a surplus bit — and the bytes are unchanged.
    const signature = b64u(new Uint8Array(64).fill(7));
    expect(signature).toHaveLength(86);
    expect(() => b64uDecode(mutateSurplusBits(signature))).toThrow(/canonical/);
  });

  it("accepts every canonical encoding it produces", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
      expect(b64uDecode(b64u(bytes))).toEqual(bytes);
    }
  });

  it("concatenates in order", () => {
    expect(hex(concatBytes(utf8("ab"), utf8("cd")))).toBe(hex(utf8("abcd")));
    expect(concatBytes()).toEqual(new Uint8Array(0));
  });

  describe("timingSafeEqual", () => {
    it("compares by value", () => {
      expect(timingSafeEqual(utf8("secret"), utf8("secret"))).toBe(true);
      expect(timingSafeEqual(utf8("secret"), utf8("secreu"))).toBe(false);
    });

    it("returns false on length mismatch instead of throwing", () => {
      // node:crypto's timingSafeEqual throws on unequal lengths, which turns
      // a signature check into an unhandled exception on malformed input.
      expect(timingSafeEqual(utf8("short"), utf8("longer"))).toBe(false);
    });

    it("is false for a first-byte difference and a last-byte difference alike", () => {
      expect(timingSafeEqual(utf8("Xbcdef"), utf8("abcdef"))).toBe(false);
      expect(timingSafeEqual(utf8("abcdeX"), utf8("abcdef"))).toBe(false);
    });
  });
});

describe("digest", () => {
  it("matches the NIST SHA-256 vector for 'abc'", () => {
    expect(hex(b64uDecode(digestString("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the NIST SHA-256 vector for the empty string", () => {
    expect(hex(b64uDecode(digestB64u(new Uint8Array(0))))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes structurally equal objects identically regardless of key order", () => {
    expect(digestJson({ a: 1, b: 2 })).toBe(digestJson({ b: 2, a: 1 }));
  });

  it("distinguishes objects that differ only in a nested value", () => {
    expect(digestJson({ o: { amount: "149900" } })).not.toBe(
      digestJson({ o: { amount: "149901" } }),
    );
  });

  it("refuses to hash a bigint amount", () => {
    expect(() => digestJson({ amount: 1n } as never)).toThrow(/bigint/);
  });
});

describe("keys", () => {
  it("derives kid as the RFC 7638 thumbprint of the public key", async () => {
    const key = await generateKey(MANDATE_ALG);
    expect(key.kid).toBe(await thumbprint(key.publicJwk));
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, unpadded base64url
  });

  it("generates distinct keys each call", async () => {
    const [a, b] = await Promise.all([generateKey(MANDATE_ALG), generateKey(MANDATE_ALG)]);
    expect(a.kid).not.toBe(b.kid);
  });

  it("supports both algorithms with their intended shapes", async () => {
    const mandate = await generateKey(MANDATE_ALG);
    const checkpoint = await generateKey(CHECKPOINT_ALG);
    expect(mandate.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(checkpoint.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
  });

  it("rejects an unsupported algorithm", async () => {
    await expect(generateKey("RS256" as never)).rejects.toThrow(KeyError);
  });

  describe("publicPartOf", () => {
    it("strips the private scalar", async () => {
      const key = await generateKey(MANDATE_ALG);
      expect(key.privateJwk.d).toBeDefined();
      expect(publicPartOf(key.privateJwk).d).toBeUndefined();
    });

    // Allow-list, not deny-list: an unknown parameter must not survive by
    // default, or a future JWK field could leak private material.
    it("drops unrecognized parameters rather than passing them through", async () => {
      const key = await generateKey(MANDATE_ALG);
      const contaminated = { ...key.privateJwk, some_future_secret: "leak" };
      expect(publicPartOf(contaminated as never)).not.toHaveProperty("some_future_secret");
    });
  });

  it("refuses to import a private key where a public one is expected", async () => {
    const key = await generateKey(MANDATE_ALG);
    await expect(importPublicKey(key.privateJwk)).rejects.toThrow(/private key/);
  });

  // A key that names itself something other than its own thumbprint is either
  // a bug or an attempt to be resolved under a trusted identity.
  it("rejects a JWK whose kid disagrees with its own key material", async () => {
    const key = await generateKey(MANDATE_ALG);
    const lying = { ...key.publicJwk, kid: "not-the-real-thumbprint" };
    await expect(importPublicKey(lying)).rejects.toThrow(/does not match/);
  });

  it("round-trips a private key through JWK export and import", async () => {
    const original = await generateKey(MANDATE_ALG);
    const restored = await importPrivateKey(original.privateJwk);
    expect(restored.kid).toBe(original.kid);

    const jws = await sign({ hello: "world" }, restored, TYP_MANDATE);
    const verified = await verify(jws, await importPublicKey(original.publicJwk), TYP_MANDATE);
    expect(verified.payload).toEqual({ hello: "world" });
  });
});

describe("JWS", () => {
  it("signs and verifies a round trip", async () => {
    const key = await generateKey(MANDATE_ALG);
    const pub = await importPublicKey(key.publicJwk);
    const jws = await sign({ sub: "usr_1", amount: "149900" }, key, TYP_MANDATE);

    const verified = await verify(jws, pub, TYP_MANDATE);
    expect(verified.payload).toEqual({ sub: "usr_1", amount: "149900" });
    expect(verified.header).toMatchObject({ alg: "ES256", kid: key.kid, typ: TYP_MANDATE });
    expect(verified.compact).toBe(jws);
  });

  it("serializes the payload canonically, so hashes are reproducible", async () => {
    const key = await generateKey(MANDATE_ALG);
    const a = await sign({ b: 2, a: 1 }, key, TYP_MANDATE);
    const b = await sign({ a: 1, b: 2 }, key, TYP_MANDATE);

    // ES256 signatures differ per call by design, but the payload segment —
    // the part that gets hashed for request binding — must be identical.
    const payloadOf = (jws: string) => jws.split(".")[1];
    expect(payloadOf(a)).toBe(payloadOf(b));
  });

  it("rejects a tampered payload", async () => {
    const key = await generateKey(MANDATE_ALG);
    const pub = await importPublicKey(key.publicJwk);
    const jws = await sign({ amount: "149900" }, key, TYP_MANDATE);

    const [h, , s] = jws.split(".") as [string, string, string];
    const forged = `${h}.${b64u(utf8(canonical({ amount: "1" })))}.${s}`;

    await expect(verify(forged, pub, TYP_MANDATE)).rejects.toThrow(SignatureVerificationError);
  });

  it("rejects a signature from a different key", async () => {
    const signer = await generateKey(MANDATE_ALG);
    const other = await generateKey(MANDATE_ALG);
    const jws = await sign({ a: 1 }, signer, TYP_MANDATE);

    await expect(verify(jws, await importPublicKey(other.publicJwk), TYP_MANDATE)).rejects.toThrow(
      SignatureVerificationError,
    );
  });

  // Without a typ check, a validly-signed artifact of one kind can be
  // presented where another kind is expected — an open mandate passed off as
  // a closed one, or a receipt as a mandate.
  it("rejects a validly signed artifact of the wrong type", async () => {
    const key = await generateKey(MANDATE_ALG);
    const pub = await importPublicKey(key.publicJwk);
    const receipt = await sign({ a: 1 }, key, TYP_RECEIPT);

    await expect(verify(receipt, pub, TYP_MANDATE)).rejects.toThrow(/wrong artifact type/);
  });

  it("requires a typ when signing", async () => {
    const key = await generateKey(MANDATE_ALG);
    await expect(sign({ a: 1 }, key, "")).rejects.toThrow(/typ/);
  });

  // The alg:none family of attacks. jose pins the algorithm from the key we
  // pass, so a header claiming otherwise cannot redirect verification.
  it("ignores an attacker-supplied alg in the header", async () => {
    const key = await generateKey(MANDATE_ALG);
    const pub = await importPublicKey(key.publicJwk);
    const jws = await sign({ a: 1 }, key, TYP_MANDATE);

    const [, p, s] = jws.split(".") as [string, string, string];
    const forgedHeader = b64u(utf8(canonical({ alg: "none", kid: key.kid, typ: TYP_MANDATE })));

    await expect(verify(`${forgedHeader}.${p}.${s}`, pub, TYP_MANDATE)).rejects.toThrow(
      SignatureVerificationError,
    );
  });

  it("verifies Ed25519 as well as ES256", async () => {
    const key = await generateKey(CHECKPOINT_ALG);
    const pub = await importPublicKey(key.publicJwk);
    const jws = await sign(
      { size: 4211, root: "abc" },
      key,
      "application/countersign-checkpoint+jws",
    );

    const verified = await verify(jws, pub, "application/countersign-checkpoint+jws");
    expect(verified.payload).toEqual({ size: 4211, root: "abc" });
  });

  describe("decodeUnsafe", () => {
    it("reads header and payload without a key", async () => {
      const key = await generateKey(MANDATE_ALG);
      const jws = await sign({ iss: "https://countersign.example" }, key, TYP_MANDATE);

      const { header, payload } = decodeUnsafe(jws);
      expect(header.kid).toBe(key.kid);
      expect(payload).toEqual({ iss: "https://countersign.example" });
    });

    it("rejects a malformed compact serialization", () => {
      expect(() => decodeUnsafe("not.a.jws.at.all")).toThrow(/3 segments/);
      expect(() => decodeUnsafe("onlyonepart")).toThrow(/3 segments/);
      expect(() => decodeUnsafe("!!!.@@@.###")).toThrow(/base64url/);
    });
  });
});
