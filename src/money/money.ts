/**
 * Money.
 *
 * Every monetary value in Pramaan is a signed integer count of a currency's
 * minor unit (paise for INR), carried as a `bigint` alongside its currency.
 * There is no float, no `number`, and no decimal string anywhere in the money
 * path. `format()` is the only function in the codebase that knows a decimal
 * point exists, and it is display-only.
 *
 * The exponent is a property of the (currency, provider) pair rather than a
 * universal constant — Adyen's own table deviates from ISO 4217 for CLP, CVE,
 * IDR and ISK — so it lives in a lookup rather than a hardcoded `/100`.
 *
 * @see https://docs.stripe.com/currencies
 * @see https://docs.adyen.com/development-resources/currency-codes/
 */

/** Currencies this system will quote or settle in. */
export const CURRENCIES = ["INR", "USD", "JPY"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** Decimal places in the currency's minor unit. JPY is zero-decimal. */
const EXPONENT: Record<CurrencyCode, number> = {
  INR: 2,
  USD: 2,
  JPY: 0,
};

/** Human-facing name of the minor unit, used in error messages and receipts. */
const MINOR_UNIT_NAME: Record<CurrencyCode, string> = {
  INR: "paise",
  USD: "cents",
  JPY: "yen",
};

declare const MinorBrand: unique symbol;

/**
 * A count of minor units. Branded so a raw `bigint` cannot be passed where an
 * amount is expected without going through {@link money}, which validates it.
 */
export type Minor = bigint & { readonly [MinorBrand]: "MinorUnits" };

export interface Money {
  readonly amount: Minor;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(`currency mismatch: ${left} and ${right} cannot be combined`);
  }
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

export function exponentOf(currency: CurrencyCode): number {
  return EXPONENT[currency];
}

export function minorUnitName(currency: CurrencyCode): string {
  return MINOR_UNIT_NAME[currency];
}

/** Construct a Money value from a minor-unit count. */
export function money(amount: bigint, currency: CurrencyCode): Money {
  if (typeof amount !== "bigint") {
    throw new MoneyError(`amount must be a bigint, received ${typeof amount}`);
  }
  if (!isCurrencyCode(currency)) {
    throw new MoneyError(`unsupported currency: ${String(currency)}`);
  }
  return { amount: amount as Minor, currency };
}

export const zero = (currency: CurrencyCode): Money => money(0n, currency);

/**
 * Parse a wire representation into Money.
 *
 * Accepts only `{ amount: <integer>, currency: <code> }`, matching the shape
 * Square, Adyen and ACP all use. A float such as `49.99` is rejected outright
 * rather than helpfully multiplied by 100 — an agent that sends rupees where
 * paise are expected must get a 400, not a silent 100x error.
 */
export function parseMoney(input: unknown): Money {
  if (typeof input !== "object" || input === null) {
    throw new MoneyError("expected an object of the form { amount, currency }");
  }
  const { amount, currency } = input as { amount?: unknown; currency?: unknown };

  if (!isCurrencyCode(currency)) {
    throw new MoneyError(`unsupported or missing currency: ${String(currency)}`);
  }
  if (typeof amount === "bigint") {
    return money(amount, currency);
  }
  if (typeof amount !== "number") {
    throw new MoneyError(
      `amount must be an integer count of ${minorUnitName(currency)}, received ${typeof amount}`,
    );
  }
  if (!Number.isInteger(amount)) {
    throw new MoneyError(
      `amount must be an integer count of ${minorUnitName(currency)}, received ${amount}. ` +
        `Did you send a decimal currency value instead of minor units?`,
    );
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(`amount ${amount} exceeds the safe integer range`);
  }
  return money(BigInt(amount), currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function abs(a: Money): Money {
  return money(a.amount < 0n ? -a.amount : a.amount, a.currency);
}

/** Multiply by an integer count, e.g. a line-item quantity. */
export function multiply(a: Money, factor: bigint): Money {
  if (typeof factor !== "bigint") {
    throw new MoneyError(`factor must be a bigint, received ${typeof factor}`);
  }
  return money(a.amount * factor, a.currency);
}

export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(currency));
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export const equals = (a: Money, b: Money): boolean => compare(a, b) === 0;
export const lessThan = (a: Money, b: Money): boolean => compare(a, b) === -1;
export const lessThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) <= 0;
export const greaterThan = (a: Money, b: Money): boolean => compare(a, b) === 1;
export const greaterThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) >= 0;

export const isZero = (a: Money): boolean => a.amount === 0n;
export const isNegative = (a: Money): boolean => a.amount < 0n;
export const isPositive = (a: Money): boolean => a.amount > 0n;

/**
 * Split `total` across `weights`, guaranteeing the parts sum exactly to the
 * total.
 *
 * Uses the Largest Remainder Method: floor-divide by weight, then hand the
 * leftover minor units to the buckets with the largest fractional remainders,
 * breaking ties by index so the result is deterministic.
 *
 * Fowler's `allocate` walks the remainder out in list order instead, which is
 * also correct but order-dependent — `allocate(5, [70, 30])` and
 * `allocate(5, [30, 70])` disagree about who gets the odd paisa. Largest
 * remainder is defensible to a merchant; list order is arbitrary.
 *
 * @see https://www.betterment.com/engineering/penny-precise-allocation-functions
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new MoneyError("cannot allocate across zero buckets");
  }
  if (weights.some((w) => w < 0n)) {
    throw new MoneyError("weights must be non-negative");
  }

  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) {
    throw new MoneyError("weights must sum to a positive value");
  }

  // Negative totals (refund splits) are allocated on the magnitude and then
  // negated. Doing it directly would rely on bigint division truncating toward
  // zero, which distributes the remainder differently for negatives and breaks
  // the symmetry a reviewer would reasonably expect.
  if (total.amount < 0n) {
    return allocate(negate(total), weights).map(negate);
  }

  const parts = weights.map((w) => (total.amount * w) / weightSum);
  const distributed = parts.reduce((a, b) => a + b, 0n);
  let remainder = total.amount - distributed;

  // remainder < weights.length always, so one pass suffices.
  const order = weights
    .map((w, index) => ({ index, fraction: (total.amount * w) % weightSum }))
    .sort((a, b) => {
      if (a.fraction > b.fraction) return -1;
      if (a.fraction < b.fraction) return 1;
      return a.index - b.index;
    });

  for (let i = 0; remainder > 0n; i++, remainder--) {
    const bucket = order[i % order.length];
    if (bucket === undefined) break;
    parts[bucket.index] = (parts[bucket.index] ?? 0n) + 1n;
  }

  return parts.map((amount) => money(amount, total.currency));
}

/** Split evenly across `n` buckets, preserving the total. */
export function allocateEvenly(total: Money, n: number): Money[] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new MoneyError(`bucket count must be a positive integer, received ${n}`);
  }
  return allocate(
    total,
    Array.from({ length: n }, () => 1n),
  );
}

/** Serialize for the wire. Mirrors ACP's `Price` object. */
export function toJSON(m: Money): { amount: string; currency: CurrencyCode } {
  return { amount: m.amount.toString(), currency: m.currency };
}

/**
 * Render for humans. The only place a decimal point is introduced, and never
 * used as an input to further arithmetic.
 */
export function format(m: Money, locale = "en-IN"): string {
  const exponent = exponentOf(m.currency);
  const negative = m.amount < 0n;
  const magnitude = negative ? -m.amount : m.amount;
  const divisor = 10n ** BigInt(exponent);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;

  const decimal =
    exponent === 0 ? whole.toString() : `${whole}.${fraction.toString().padStart(exponent, "0")}`;

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(Number(negative ? `-${decimal}` : decimal));
}
