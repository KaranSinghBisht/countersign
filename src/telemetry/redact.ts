/**
 * Log redaction, by allow-list.
 *
 * Every logging library ships a deny-list: name the fields to hide, and
 * everything else goes to disk. That fails the moment somebody adds
 * `customerVpa`, or logs a whole Razorpay payment object, or renames `email`
 * to `contact`. The deny-list is silently incomplete and nothing tells you.
 *
 * This inverts it. A field is logged only if its key is explicitly known to
 * be safe; anything unrecognized becomes `[redacted]`. Adding a new field to
 * a log line is therefore a no-op until somebody deliberately adds it here,
 * which is a code review nobody can skip by accident.
 *
 * Strings that ARE allowed still get scanned for high-risk patterns, because
 * `msg` and `reason` are free text and a well-meaning template can
 * interpolate a payment identifier into one.
 *
 * This is the enforcement half of the RBI localization posture documented in
 * docs/COMPLIANCE.md: payment system data must not leave India, and a log
 * shipped to a hosted aggregator has left.
 */

/**
 * Leaf keys whose values are safe to record verbatim.
 *
 * The test for adding one: could this field ever hold a person's name, a
 * contact detail, an address, an account identifier, or free text a user
 * supplied? If yes, it does not belong here.
 */
export const SAFE_KEYS: ReadonlySet<string> = new Set([
  // Correlation
  "request_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "event_id",
  "idempotency_key",
  "seq",

  // Operational facts about this process, not about anyone — redacting the
  // listen port and the shutdown signal made the two most useful log lines
  // unreadable.
  "port",
  "signal",
  "nonces",
  "leases",
  "settled",
  "events",
  "outbox_done",
  "size",
  "outbox_id",
  "kind",
  "outcome",
  "detail",
  "exceptions",
  "adopted",
  "kinds",

  // Domain identifiers we mint or that identify a thing, not a person
  "order_id",
  "payment_id",
  "refund_id",
  "transfer_id",
  "session_id",
  "checkout_session_id",
  "mandate_id",
  "open_jti",
  "closed_jti",
  "jti",
  "kid",
  "agent_id",
  "agent_version",
  "policy_id",
  "rule_id",
  "sku",
  "product_id",
  "receipt",

  // Money. Always integers plus a currency code, never free text.
  "amount",
  "amount_paise",
  "currency",
  "spent_before_paise",
  "spent_after_paise",
  "budget_max_paise",
  "remaining_paise",

  // Enumerated state
  "status",
  "decision",
  "effect",
  "state",
  "from_state",
  "to_state",
  "rail",
  "method",
  "reason_code",
  "error_code",
  "problem_type",
  "constraint_type",
  "first_deny",

  // HTTP and runtime
  "http_method",
  "route",
  "status_code",
  "duration_ms",
  "attempt",
  "retry_count",
  "level",
  "time",
  "pid",
  "hostname",
  "env",
  "version",
  // Deliberately `service`, not `name`: pino's logger name would have put
  // `name` on the allow-list, and `name` is also the key a cardholder or a
  // customer arrives under.
  "service",

  // Counts and sizes
  "count",
  "size",
  "tree_size",
  "chain_depth",
  "actions_before",
  "actions_after",
  "bytes",

  // Free text we author ourselves, allowed but always scrubbed.
  // `message` is absent on purpose — that is the key a customer's own words
  // arrive under in a conversational checkout.
  "msg",
  "reason",

  // Errors. The values under these are produced by this module's own Error
  // branch, which has already scrubbed them.
  "err",
  "error",
  "error_name",
  "error_message",
  "error_stack",
  "error_cause",
]);

/**
 * Key shapes that are safe by construction.
 *
 * A digest is a commitment, not content — `prompt_sha256` is exactly how a
 * prompt gets referenced in the audit log without the prompt being retained.
 */
const SAFE_KEY_PATTERNS: readonly RegExp[] = [
  /_sha256$/,
  /_hash$/,
  /^hash$/,
  /_b64u$/,
  /_at$/, // created_at, captured_at — timestamps
  /_ms$/,
  /_count$/,
  /_paise$/,
  /^is_/,
  /^has_/,
];

export const REDACTED = "[redacted]";

function isSafeKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return true;
  return SAFE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Luhn check, used to avoid redacting every long number.
 *
 * Order references and sequence numbers are long digit strings too; without
 * this, the scrubber would eat them and make logs useless — which is how
 * redaction ends up being turned off.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface ScrubPattern {
  readonly label: string;
  readonly pattern: RegExp;
  readonly confirm?: (match: string) => boolean;
}

/**
 * Patterns scrubbed even from allow-listed strings.
 *
 * Ordering matters: JWTs first, because a compact JWS contains base64url runs
 * that later patterns would partially match and mangle into something that
 * still leaks.
 */
const SCRUB_PATTERNS: readonly ScrubPattern[] = [
  {
    label: "jwt",
    pattern: /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: "live-key",
    pattern: /\brzp_live_[A-Za-z0-9]+/g,
  },
  {
    label: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    // UPI virtual payment address: looks like an email but the handle has no dot.
    label: "vpa",
    pattern: /\b[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}\b/g,
  },
  {
    label: "pan",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    confirm: (match) => passesLuhn(match.replace(/[ -]/g, "")),
  },
  {
    label: "aadhaar",
    pattern: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
  },
  {
    label: "phone",
    pattern: /(?:\+91[ -]?)?\b[6-9]\d{9}\b/g,
  },
  {
    // Indian income-tax PAN, which appears on KYC records.
    label: "tax-pan",
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  },
];

/** Replace high-risk substrings with a labelled placeholder. */
export function scrubString(value: string): string {
  let out = value;
  for (const { label, pattern, confirm } of SCRUB_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), (match) =>
      confirm === undefined || confirm(match) ? `[redacted:${label}]` : match,
    );
  }
  return out;
}

/** Depth beyond which we stop descending, to bound work on cyclic-ish input. */
const MAX_DEPTH = 8;

/**
 * Redact a value for logging.
 *
 * The root object's keys are checked against the allow-list; unrecognized
 * keys have their values replaced wholesale, so a nested object under a
 * rejected key never gets walked at all.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;

  switch (typeof value) {
    case "boolean":
    case "number":
      return value;
    case "bigint":
      // Money is bigint paise. JSON.stringify throws on it, and a logger that
      // throws inside a catch block loses the error it was reporting.
      return value.toString();
    case "string":
      return scrubString(value);
    case "function":
    case "symbol":
      return REDACTED;
  }

  if (depth >= MAX_DEPTH) return "[truncated:depth]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  // Deliberately not `name`/`message`/`stack`: those keys are not on the
  // allow-list (a cardholder arrives under `name`, a customer's words under
  // `message`), and this object is walked again on its way through the
  // logger's formatter. Prefixed keys survive that second pass.
  if (value instanceof Error) {
    return {
      error_name: value.name,
      error_message: scrubString(value.message),
      ...(value.stack === undefined ? {} : { error_stack: scrubString(value.stack) }),
      ...(value.cause === undefined
        ? {}
        : { error_cause: redactValue(value.cause, depth + 1, seen) }),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return REDACTED;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSafeKey(key) ? redactValue(item, depth + 1, seen) : REDACTED;
  }
  return out;
}
