/**
 * Differential test: our RFC 8785 implementation against the reference one.
 *
 * `src/crypto/jcs.ts` is hand-written so the verifier can own its
 * canonicalization outright. That is only defensible if it is checked against
 * an independent implementation over inputs nobody chose by hand, which is
 * what this file does — `canonicalize` (erdtman, the RFC author's own
 * implementation) stays a devDependency purely as an oracle.
 *
 * If these ever disagree, our hashes have diverged from the rest of the world
 * and the correct response is to assume we are wrong.
 */

import canonicalizeReference from "canonicalize";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { jcs } from "../../src/crypto/jcs.js";

fc.configureGlobal({ seed: 0x70726d6e, numRuns: 2000 });

/** The reference implementation is CJS with an ESM-shaped .d.ts; pin the real shape. */
const reference = canonicalizeReference as unknown as (input: unknown) => string | undefined;

/** Strings that exercise escaping, ordering and normalization edge cases. */
const trickyString = () =>
  fc.oneof(
    fc.string(),
    fc.constantFrom(
      "",
      " ",
      "\u0000",
      "\u001f",
      "\u007f",
      "\u0080",
      '"',
      "\\",
      "\\\\",
      '\\"',
      "\n",
      "\r",
      "\t",
      "\b",
      "\f",
      "</script>",
      "€",
      "ö",
      "דּ",
      "\ufb33",
      "😀", // astral: a surrogate pair, which sorts before U+E000 by code unit
      "\ud83d\ude00",
      "\uffff",
      "\ue000",
      "a",
      "A",
      "1",
      "０",
      "ﬀ",
      "ff",
    ),
    // `grapheme` rather than `binary`: binary generates lone surrogates,
    // which we reject on purpose and the reference accepts, so it would fail
    // this comparison for a difference already covered explicitly below.
    fc.string({ unit: "grapheme", maxLength: 12 }),
  );

const jsonValue = () =>
  fc.letrec<{ value: unknown }>((tie) => ({
    value: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.constant(null),
      fc.boolean(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.integer(),
      trickyString(),
      fc.array(tie("value"), { maxLength: 6 }),
      fc.dictionary(trickyString(), tie("value"), { maxKeys: 8 }),
    ),
  })).value;

describe("differential against the reference implementation", () => {
  it("agrees on arbitrary JSON values", () => {
    fc.assert(
      fc.property(jsonValue(), (value) => {
        expect(jcs(value)).toBe(reference(value));
      }),
    );
  });

  it("agrees on objects with adversarial key sets", () => {
    fc.assert(
      fc.property(fc.dictionary(trickyString(), fc.integer(), { maxKeys: 20 }), (obj) => {
        expect(jcs(obj)).toBe(reference(obj));
      }),
    );
  });

  it("agrees on numbers across the double range", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.integer(),
          fc.constantFrom(
            0,
            -0,
            1,
            -1,
            0.1,
            1e-7,
            1e21,
            1e-27,
            1e30,
            4.5,
            2e-3,
            // biome-ignore lint/correctness/noPrecisionLoss: RFC 8785 §3.2.2.3 vector
            333333333.33333329,
            Number.MAX_SAFE_INTEGER,
            Number.MIN_SAFE_INTEGER,
            Number.EPSILON,
            Number.MAX_VALUE,
            Number.MIN_VALUE,
            5e-324,
          ),
        ),
        (n) => {
          expect(jcs({ n })).toBe(reference({ n }));
        },
      ),
    );
  });

  it("agrees on deeply nested structures", () => {
    fc.assert(
      fc.property(
        fc.letrec<{ node: unknown }>((tie) => ({
          node: fc.oneof(
            { depthSize: "large", maxDepth: 8 },
            fc.integer(),
            fc.record({ a: tie("node"), b: tie("node") }),
            fc.array(tie("node"), { maxLength: 3 }),
          ),
        })).node,
        (value) => {
          expect(jcs(value)).toBe(reference(value));
        },
      ),
    );
  });
});

describe("where we deliberately diverge from the reference", () => {
  // The reference silently drops undefined properties and silently invokes
  // toJSON(). Both change what gets hashed relative to what the caller
  // passed, so we refuse instead. These are the only intentional differences.
  it("rejects undefined properties that the reference would drop", () => {
    expect(reference({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => jcs({ a: 1, b: undefined })).toThrow(/undefined/);
  });

  it("rejects class instances that the reference would convert via toJSON", () => {
    expect(reference({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
    expect(() => jcs({ d: new Date(0) })).toThrow(/only plain objects/);
  });

  it("rejects lone surrogates, which cannot survive a UTF-8 round trip", () => {
    expect(() => jcs({ s: "\ud800" })).toThrow(/lone high surrogate/);
    expect(() => jcs({ s: "\udc00" })).toThrow(/lone low surrogate/);
    expect(() => jcs({ "\ud800": 1 })).toThrow(/lone high surrogate/);
  });

  it("accepts a well-formed surrogate pair", () => {
    expect(jcs({ s: "😀" })).toBe(reference({ s: "😀" }));
  });
});
