import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalizable,
  CanonicalizationError,
  canonical,
  canonicalBytes,
  type JsonValue,
} from "./canonical.js";

fc.configureGlobal({ seed: 0x70726d6e, numRuns: 300 });

describe("RFC 8785 conformance", () => {
  // Section 3.2.3. Keys sort by UTF-16 code unit, not by locale, not by
  // codepoint. Note \n (U+000A) sorts before \r (U+000D), which is the
  // opposite of the order they appear in the input.
  it("sorts object keys by UTF-16 code unit", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\u000a": "Newline",
      "1": "One",
      "\u0080": "Control\u007f",
      "\u00f6": "Latin Small Letter O With Diaeresis",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "</script>": "Browser Challenge",
    };
    const keys = [...canonical(input).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => m[1]);
    expect(keys).toEqual(["\\n", "\\r", "1", "</script>", "\u0080", "\u00f6", "\u20ac", "\ufb33"]);
  });

  // Section 3.2.2.3. Numbers use the ECMAScript Number::toString algorithm,
  // so 4.50 is "4.5" and 1e30 is "1e+30". This is the part JSON.stringify
  // with sorted keys does NOT pin down across implementations.
  it("serializes numbers in ECMAScript form", () => {
    // The narrowing to 333333333.3333333 is the behaviour under test, not an accident.
    // biome-ignore lint/correctness/noPrecisionLoss: RFC 8785 §3.2.2.3 vector
    expect(canonical({ n: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] })).toBe(
      '{"n":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
    );
  });

  it("normalizes negative zero to zero", () => {
    expect(canonical({ a: -0 })).toBe('{"a":0}');
    expect(canonical({ a: -0 })).toBe(canonical({ a: 0 }));
  });

  it("emits no insignificant whitespace", () => {
    expect(canonical({ a: 1, b: [1, 2], c: { d: 3 } })).toBe('{"a":1,"b":[1,2],"c":{"d":3}}');
  });

  it("preserves array order while sorting object keys within elements", () => {
    expect(canonical({ b: { d: 1, c: 2 }, a: [3, { z: 1, y: 2 }] })).toBe(
      '{"a":[3,{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonical({ a: Number.NaN } as unknown as JsonValue)).toThrow(
      CanonicalizationError,
    );
    expect(() => canonical({ a: Number.POSITIVE_INFINITY } as unknown as JsonValue)).toThrow(
      CanonicalizationError,
    );
  });
});

describe("guards against silent corruption", () => {
  // The single most likely mistake in this codebase: money is bigint paise,
  // and JSON cannot serialize a bigint. The canonicalizer's own error is
  // "Do not know how to serialize a BigInt", which does not tell you what to
  // do about it at 2am on day twelve.
  it("rejects bigint with an actionable message", () => {
    expect(() => canonical({ amount: 149900n } as unknown as JsonValue)).toThrow(
      /bigint cannot be canonicalized/,
    );
    expect(() => canonical({ amount: 149900n } as unknown as JsonValue)).toThrow(/toJSON/);
  });

  // An undefined property vanishes from the output, so the hash would reflect
  // an object the caller never intended to commit to.
  it("rejects undefined rather than dropping the key", () => {
    expect(() => canonical({ a: 1, b: undefined } as unknown as JsonValue)).toThrow(/undefined/);
  });

  it("rejects class instances that would be silently converted by toJSON", () => {
    expect(() => canonical({ when: new Date(0) } as unknown as JsonValue)).toThrow(
      /only plain objects/,
    );
    expect(() => canonical({ ids: new Set([1]) } as unknown as JsonValue)).toThrow(
      /only plain objects/,
    );
  });

  it("names the path to the offending value", () => {
    expect(() => assertCanonicalizable({ order: { items: [{ price: 1n }] } })).toThrow(
      /\$\.order\.items\[0\]\.price/,
    );
  });

  it("accepts null, and nested plain structures", () => {
    expect(() => assertCanonicalizable({ a: null, b: [null, { c: null }] })).not.toThrow();
  });
});

describe("determinism", () => {
  it("is insensitive to key insertion order", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean()), {
          maxKeys: 12,
        }),
        (obj) => {
          const shuffled = Object.fromEntries(
            Object.entries(obj).sort(([a], [b]) => (a < b ? 1 : -1)),
          );
          expect(canonical(shuffled)).toBe(canonical(obj));
        },
      ),
    );
  });

  it("produces identical bytes on repeated calls", () => {
    fc.assert(
      fc.property(
        fc.object({
          maxDepth: 3,
          values: [fc.integer(), fc.string(), fc.boolean(), fc.constant(null)],
        }),
        (obj) => {
          expect(canonicalBytes(obj as JsonValue)).toEqual(canonicalBytes(obj as JsonValue));
        },
      ),
    );
  });

  it("round-trips through JSON.parse unchanged", () => {
    fc.assert(
      fc.property(
        fc.object({
          maxDepth: 3,
          values: [fc.integer(), fc.string(), fc.boolean(), fc.constant(null)],
        }),
        (obj) => {
          const once = canonical(obj as JsonValue);
          expect(canonical(JSON.parse(once) as JsonValue)).toBe(once);
        },
      ),
    );
  });
});
