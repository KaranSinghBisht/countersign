/**
 * Configuration, validated once at boot.
 *
 * The rule here is that the process either starts fully configured or does
 * not start. A service that boots with a missing webhook secret and only
 * discovers it on the first delivery has turned a config error into a
 * money-losing incident an hour later, in a code path nobody is watching.
 *
 * Secrets are read from the environment and never from CLI flags: argv is
 * world-readable through `ps` on a shared host, which is also why Razorpay's
 * own MCP server documentation warns against passing keys that way.
 */

import type { JWK } from "jose";
import { z } from "zod";
import { b64uDecode, fromUtf8 } from "./crypto/encoding.js";

const NonEmpty = z.string().trim().min(1);

/**
 * A secret must be present and long enough to be a real secret. The minimum
 * is deliberately low — it catches `""`, `"changeme"` and a truncated paste,
 * not weak entropy, which no length check can detect.
 */
const Secret = z.string().min(16, "must be at least 16 characters");

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /**
     * Our own origin. Used as the `aud` of every mandate and as the realm in
     * the 402 challenge, so a mandate minted for another deployment cannot be
     * replayed against this one.
     */
    COUNTERSIGN_BASE_URL: z.url(),

    DATABASE_URL: z.url().refine((v) => v.startsWith("postgres"), {
      message: "must be a postgres:// or postgresql:// URL",
    }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /**
     * Razorpay test-mode credentials.
     *
     * The `rzp_test_` check is a real safety interlock, not decoration: this
     * codebase creates orders and captures payments, and a live key in a
     * hackathon repo moves actual money. CI greps for `rzp_live_` as well.
     */
    RAZORPAY_KEY_ID: NonEmpty.refine((v) => v.startsWith("rzp_test_"), {
      message: "must be a TEST-mode key id (rzp_test_...). This service refuses to run live.",
    }),
    RAZORPAY_KEY_SECRET: Secret,
    /** Distinct from the API key secret. Signs webhook bodies; rotated separately. */
    RAZORPAY_WEBHOOK_SECRET: Secret,
    /**
     * `fake` swaps the outbox worker's Razorpay client for the in-memory one
     * the tests use, so a laptop without test-mode credentials still creates
     * "orders" and the whole loop — order id, receipt, /audit/orders — can be
     * walked. Refused in production: nothing fake may stand behind a real
     * public URL.
     */
    RAZORPAY_MODE: z.enum(["live", "fake"]).default("live"),
    /**
     * Razorpay retries a webhook for 24 hours, so a delivery can legitimately
     * arrive a day late. Copying Stripe's 5-minute tolerance here would reject
     * exactly the retries the replay window exists to accept.
     */
    WEBHOOK_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(26 * 60 * 60),

    /**
     * Reserved for a 402 challenge HMAC. Nothing in this tree reads it —
     * there is no challenge route — so it is optional. If set, it must still
     * look like a secret, so a pasted `"changeme"` fails closed.
     */
    CHALLENGE_HMAC_SECRET: Secret.optional(),
    CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(10).max(900).default(300),

    /**
     * Signing keys as base64url-encoded JWKs.
     *
     * On the box, in the environment, with no HSM and no KMS — a limitation
     * stated plainly in docs/LIMITATIONS.md rather than papered over. Whoever
     * holds the checkpoint key can rebuild and re-sign the audit log.
     */
    MANDATE_ISSUER_JWK: NonEmpty,
    AGENT_SIGNING_JWK: NonEmpty,
    CHECKPOINT_JWK: NonEmpty,

    /**
     * The origin named in signed checkpoint notes. Must match the `origin` a
     * verifier pins in trust.json, or every exported bundle fails L10.
     */
    AUDIT_ORIGIN: NonEmpty.default("countersign.dev/audit"),

    /** Mandate lifetimes. Closed mandates are short by design. */
    OPEN_MANDATE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(24 * 60 * 60),
    CLOSED_MANDATE_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(120),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  })
  .superRefine((cfg, ctx) => {
    // .env.example ships placeholder keys. Under `live` the worker would call
    // Razorpay with them, every order would 401 in the log, and the purchase
    // would still answer "permitted" — a trap for anyone who skipped the README.
    const placeholder =
      /^rzp_test_x+$/.test(cfg.RAZORPAY_KEY_ID) || cfg.RAZORPAY_KEY_SECRET.startsWith("replace_me");
    if (cfg.RAZORPAY_MODE === "live" && placeholder) {
      ctx.addIssue({
        code: "custom",
        path: ["RAZORPAY_MODE"],
        message:
          "live with the placeholder keys from .env.example — paste real rzp_test_ keys, or set RAZORPAY_MODE=fake",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override readonly name: string = "ConfigError";
}

/**
 * Validate an environment.
 *
 * Reports every problem at once. Fixing one missing variable, restarting, and
 * discovering the next one is a miserable loop that config validation exists
 * to prevent.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (result.success) return result.data;

  // Grouped by variable, because a single bad value can raise several issues
  // — a malformed DATABASE_URL fails both the URL check and the scheme
  // refinement — and "4 problems" across 3 variables reads like a bug.
  const byVariable = new Map<string, string[]>();
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "(root)";
    byVariable.set(key, [...(byVariable.get(key) ?? []), issue.message]);
  }

  const problems = [...byVariable.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([variable, messages]) => `  ${variable}: ${messages.join("; ")}`)
    .join("\n");

  throw new ConfigError(
    `invalid configuration — ${byVariable.size} variable(s):\n${problems}\n\n` +
      `See .env.example for the full set of required variables.`,
  );
}

let cached: Config | undefined;

/** The validated config, parsed once. */
export function config(): Config {
  if (cached === undefined) cached = parseConfig();
  return cached;
}

/** Reset the memoized config. Tests only. */
export function resetConfigForTesting(): void {
  cached = undefined;
}

export const isProduction = (c: Config): boolean => c.NODE_ENV === "production";
export const isTest = (c: Config): boolean => c.NODE_ENV === "test";

/** Decode a base64url-encoded JWK from the environment. */
export function decodeEnvJwk(encoded: string): JWK {
  try {
    return JSON.parse(fromUtf8(b64uDecode(encoded))) as JWK;
  } catch {
    throw new ConfigError("signing JWK is not valid base64url JSON");
  }
}
