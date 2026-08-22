/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Implemented here rather than taken from a dependency, for two reasons.
 *
 * First, canonicalization is the cross-implementation contract of this whole
 * project: the standalone verifier reproduces our hashes only if it agrees
 * with us on these exact bytes. That contract is worth owning, reading, and
 * testing directly rather than inheriting.
 *
 * Second, it is genuinely small. RFC 8785 delegates the hard parts — number
 * formatting and string escaping — to ECMAScript's own `JSON.stringify`,
 * which the language already specifies exactly. What remains is property
 * sorting by UTF-16 code unit, whitespace elimination, and rejecting the
 * inputs JSON cannot round-trip.
 *
 * `test/unit/jcs-oracle.test.ts` differentially tests this against the
 * `canonicalize` reference implementation over generated inputs, so owning
 * the code does not mean trusting it on faith.
 *
 * @see https://datatracker.ietf.org/doc/rfc8785/
 */

export class JcsError extends Error {
  override readonly name: string = "JcsError";
}

/**
 * Serialize a number per RFC 8785 §3.2.2.3.
 *
 * The RFC adopts ECMAScript's `Number::toString`, which is exactly what
 * `String(n)` implements — including `1e+30` for 1e30 and `333333333.3333333`
 * for a value with more digits than a double can hold.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new JcsError(`JSON cannot represent ${String(value)}`);
  }
  // Collapses -0 to "0". RFC 8785 §3.2.2.3 requires it, and a hash that
  // depended on the sign of zero would be a nasty way to lose an afternoon.
  if (value === 0) return "0";
  return String(value);
}

/**
 * Serialize a string per RFC 8785 §3.2.2.2, which defers to ECMAScript's
 * `JSON.stringify`: escape only `"`, `\`, and U+0000–U+001F, preferring the
 * short forms (\b \t \n \f \r) and using \uXXXX otherwise. Everything else,
 * including U+007F and all non-ASCII, is emitted literally as UTF-8.
 */
function serializeString(value: string): string {
  // Well-formed JSON.stringify (ES2019) escapes lone surrogates as \uXXXX
  // rather than emitting invalid UTF-8. RFC 8785 treats such input as an
  // error, and silently accepting it would let two distinct inputs collide
  // after a UTF-8 round trip.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new JcsError(`lone high surrogate at index ${i}; input is not valid Unicode`);
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new JcsError(`lone low surrogate at index ${i}; input is not valid Unicode`);
    }
  }
  return JSON.stringify(value);
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      try {
        return serializeNumber(value);
      } catch (cause) {
        throw new JcsError(`${path}: ${(cause as Error).message}`, { cause });
      }
    case "string":
      try {
        return serializeString(value);
      } catch (cause) {
        throw new JcsError(`${path}: ${(cause as Error).message}`, { cause });
      }
    case "bigint":
      throw new JcsError(
        `${path}: bigint cannot be canonicalized. Money must be serialized with ` +
          `toJSON() (an amount string plus a currency) before hashing.`,
      );
    case "undefined":
      throw new JcsError(
        `${path}: undefined is silently dropped by JSON. Omit the key explicitly ` +
          `or use null, so the hash reflects what you meant.`,
      );
    case "function":
    case "symbol":
      throw new JcsError(`${path}: ${typeof value} cannot be canonicalized`);
  }

  if (Array.isArray(value)) {
    // Array order is significant and preserved; only object keys are sorted.
    return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new JcsError(
      `${path}: only plain objects can be canonicalized, received ` +
        `${(value as object).constructor?.name ?? "an exotic object"}. Convert it to ` +
        `a plain object first, so the hashed bytes are explicit.`,
    );
  }

  // §3.2.3: sort by UTF-16 code unit. JavaScript's default string comparison
  // is already code-unit order, which is NOT the same as codepoint order —
  // astral characters (encoded as surrogate pairs in D800..DFFF) sort before
  // U+E000..U+FFFF. The RFC specifies code-unit order, so this is correct and
  // `localeCompare` would be wrong.
  const keys = Object.keys(value as Record<string, unknown>).sort();

  const members = keys.map((key) => {
    const child = serialize((value as Record<string, unknown>)[key], `${path}.${key}`);
    return `${serializeString(key)}:${child}`;
  });

  return `{${members.join(",")}}`;
}

/** Canonical JSON text for a value, per RFC 8785. */
export function jcs(value: unknown): string {
  return serialize(value, "$");
}
