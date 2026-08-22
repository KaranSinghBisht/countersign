/**
 * Mandate claim sets.
 *
 * Two artifacts, with deliberately different lifetimes and signers:
 *
 *   OPEN   — signed by the human's issuer, long-lived, carries the
 *            constraints, and names the agent key permitted to act under it.
 *   CLOSED — signed by that agent key, one purchase, ~120s, and binds itself
 *            to both the open mandate and the specific cart being paid for.
 *
 * The pair is bound in both directions on purpose. The closed mandate points
 * up via `parent_hash`; the open mandate points down via `cnf.jwk`. One
 * direction alone is not enough — with only the upward link, any key could
 * claim a parent, and with only the downward link, a closed mandate could be
 * replayed under a different open one.
 */

import { z } from "zod";
import { CURRENCIES, type Money, money } from "../money/money.js";
import { ConstraintSchema } from "./constraints.js";

export const OPEN_MANDATE_TYP = "application/countersign-open-mandate+jws";
export const CLOSED_MANDATE_TYP = "application/countersign-closed-mandate+jws";

export const OPEN_MANDATE_VCT = "dev.countersign.mandate.spend.open.1";
export const CLOSED_MANDATE_VCT = "dev.countersign.mandate.spend.closed.1";

/**
 * Depth 2 means human → agent, and nothing further.
 *
 * Sub-delegation is left unbuilt rather than left open. Each additional hop
 * multiplies the ways attenuation can be got wrong, and buys nothing a single
 * hop cannot express for this use case.
 */
export const MAX_CHAIN_DEPTH = 2;

/**
 * A closed mandate is valid for at most two minutes.
 *
 * It authorises one specific cart at one specific moment, so a long life is
 * pure replay window. Bounding it here means a stolen closed mandate expires
 * before it is useful, even if every other check somehow passed.
 */
export const MAX_CLOSED_LIFETIME_SECONDS = 120;

/** Tolerance for clock disagreement between the signer and this server. */
export const CLOCK_SKEW_SECONDS = 30;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be unpadded base64url");

/** Crockford base32, 26 characters, first character constrained to 0-7. */
const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "must be a ULID");

const EpochSeconds = z
  .number()
  .refine(Number.isSafeInteger, "must be an integer count of seconds since the epoch")
  .refine((n) => n > 0, "must be positive");

const Sha256B64u = Base64Url.length(43, "must be a base64url SHA-256 digest");

/**
 * The agent's public key, as carried in the open mandate's `cnf`.
 *
 * `.strict()` is doing security work, not tidiness: it rejects a `d` member,
 * so a mandate cannot smuggle private key material, and it rejects any
 * unrecognised parameter that a permissive JOSE implementation downstream
 * might act on.
 */
const PublicP256Jwk = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: Base64Url,
    y: Base64Url,
    kid: z.string().min(1).optional(),
    alg: z.literal("ES256").optional(),
    use: z.literal("sig").optional(),
  })
  .strict();

export type PublicP256Jwk = z.infer<typeof PublicP256Jwk>;

/** Integer minor units on the wire, `Money` in memory. */
const MoneySchema = z
  .object({
    amount: z
      .number()
      .refine(Number.isInteger, "must be an integer count of minor units, not a decimal amount")
      .refine(Number.isSafeInteger, "exceeds the range where a JSON number is exact")
      .refine((n) => n > 0, "must be positive"),
    currency: z.enum(CURRENCIES),
  })
  .strict()
  .transform((m): Money => money(BigInt(m.amount), m.currency));

const PayeeRef = z.object({ id: z.string().min(1) }).strict();

export const OpenMandateSchema = z
  .object({
    vct: z.literal(OPEN_MANDATE_VCT),
    iss: z.url(),
    sub: z.string().min(1),
    aud: z.url(),
    jti: Ulid,
    iat: EpochSeconds,
    nbf: EpochSeconds,
    exp: EpochSeconds,

    // The agent key this mandate endorses. Downward half of the binding.
    cnf: z.object({ jwk: PublicP256Jwk }).strict(),

    purpose: z.string().min(1).max(200),
    policy_bundle_sha256: Sha256B64u,

    constraints: z.array(ConstraintSchema).min(1),
  })
  .strict()
  .refine((m) => m.nbf <= m.exp, "nbf must not be after exp")
  .refine((m) => m.iat <= m.exp, "iat must not be after exp");

export type OpenMandate = z.infer<typeof OpenMandateSchema>;

export const ClosedMandateSchema = z
  .object({
    vct: z.literal(CLOSED_MANDATE_VCT),
    iss: z.string().min(1),
    sub: z.string().min(1),
    aud: z.url(),
    jti: Ulid,
    iat: EpochSeconds,
    exp: EpochSeconds,

    // Upward half of the binding: the exact open mandate JWS this was
    // issued under, hashed over its compact serialization.
    parent_hash: Sha256B64u,

    // The exact cart being paid for. Always recomputed server-side from our
    // own quote; the value here is only ever compared, never trusted.
    request_hash: Sha256B64u,

    // Server-issued, single-use. The agent cannot mint its own.
    nonce: Base64Url.min(16),

    amount: MoneySchema,
    payee: PayeeRef,

    agent: z
      .object({
        id: z.string().min(1),
        version: z.string().min(1),
        model: z.string().min(1),
        runtime_sha256: Sha256B64u,
      })
      .strict(),

    chain_depth: z.literal(MAX_CHAIN_DEPTH),

    /**
     * Further attenuation, and OPTIONAL — the one place absence is safe.
     *
     * Omitting the array entirely means "inherit the parent's constraints
     * verbatim", which grants nothing. Supplying an array means "these are
     * my constraints", and it is then checked with `narrows`, where dropping
     * a key the parent set is a deny.
     *
     * The distinction is the whole reason this field is optional rather than
     * defaulted to `[]`: an empty array is a claim to be unconstrained, and
     * must fail. Absence is not a claim at all.
     */
    constraints: z.array(ConstraintSchema).min(1).optional(),
  })
  .strict()
  .refine((m) => m.iat <= m.exp, "iat must not be after exp")
  .refine(
    (m) => m.exp - m.iat <= MAX_CLOSED_LIFETIME_SECONDS,
    `must not be valid for longer than ${MAX_CLOSED_LIFETIME_SECONDS}s`,
  );

export type ClosedMandate = z.infer<typeof ClosedMandateSchema>;
