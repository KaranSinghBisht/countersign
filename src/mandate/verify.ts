/**
 * Mandate chain verification.
 *
 * Six checks, in a fixed order, aborting on the first failure. The order is
 * not arbitrary: each step establishes what the next one is allowed to assume,
 * so running them out of order means trusting a value that has not been
 * authenticated yet.
 *
 *   1. The open mandate verifies against a PINNED issuer key.
 *   2. The closed mandate verifies against `open.cnf.jwk` — the agent key the
 *      human endorsed, never a key the agent asserts about itself.
 *   3. `closed.parent_hash` equals the digest of the open mandate's compact
 *      JWS, so the closed one names this exact parent.
 *   4. The claims both artifacts carry agree.
 *   5. If the closed mandate restates constraints, they attenuate the open
 *      mandate's.
 *   6. `closed.request_hash` equals the digest of the checkout WE produced.
 *
 * Every failure returns a value. Nothing here throws for a rejected mandate,
 * because a rejection is an expected outcome that must be logged and audited,
 * not an exception to be caught somewhere up the stack and flattened into a
 * 500.
 *
 * This module decides whether the chain is STRUCTURALLY sound and what
 * authority it carries. It does not decide whether a purchase is within
 * budget — that is the policy engine, which consumes the constraint set this
 * returns.
 */

import { canonicalBytes } from "../crypto/canonical.js";
import { digestB64u } from "../crypto/digest.js";
import { utf8 } from "../crypto/encoding.js";
import { decodeUnsafe, verify } from "../crypto/jws.js";
import { importPublicKey, type PublicKeyRef } from "../crypto/keys.js";
import type { Constraint } from "./constraints.js";
import { effective, narrows } from "./constraints.js";
import {
  CLOCK_SKEW_SECONDS,
  CLOSED_MANDATE_TYP,
  type ClosedMandate,
  ClosedMandateSchema,
  MAX_CHAIN_DEPTH,
  OPEN_MANDATE_TYP,
  type OpenMandate,
  OpenMandateSchema,
} from "./types.js";

/**
 * Why a chain was refused.
 *
 * A closed set of codes rather than free text, because these are logged,
 * audited, and turned into protocol responses. `unresolved_constraint` is
 * deliberately absent — escalation to a human is a policy outcome, not a
 * verification failure.
 */
export type ChainFailureCode =
  | "malformed"
  | "open_signature_invalid"
  | "closed_signature_invalid"
  | "parent_binding_invalid"
  | "claims_disagree"
  | "not_attenuated"
  | "request_binding_invalid"
  | "expired"
  | "not_yet_valid";

export interface ChainFailure {
  readonly ok: false;
  readonly code: ChainFailureCode;
  readonly step: number;
  readonly reason: string;
}

export interface ChainSuccess {
  readonly ok: true;
  readonly open: OpenMandate;
  readonly closed: ClosedMandate;
  readonly openHash: string;
  readonly closedHash: string;
  /** Parent and child merged, tightest bound wins. What policy evaluates. */
  readonly constraints: readonly Constraint[];
}

export type ChainResult = ChainSuccess | ChainFailure;

export interface ChainInput {
  /** Compact JWS of the open mandate, exactly as presented. */
  readonly openJws: string;
  /** Compact JWS of the closed mandate, exactly as presented. */
  readonly closedJws: string;
  /**
   * The checkout WE produced for this request.
   *
   * Passed as a value rather than a hash so the digest is computed here, from
   * our own cart. A caller that could pass a hash could pass the agent's.
   */
  readonly checkout: Parameters<typeof canonicalBytes>[0];
  /** The nonce this server issued for this exchange. */
  readonly expectedNonce: string;
  /** Our own identity, which the mandates must be addressed to. */
  readonly audience: string;
}

export interface ChainOptions {
  /**
   * The issuer key, from our trust store.
   *
   * Required, and deliberately not resolvable from the token. A mandate that
   * could nominate the key verifying it is a mandate anyone can mint.
   */
  readonly issuerKey: PublicKeyRef;
  /** Seconds since the epoch. Injected so verification stays pure. */
  readonly now: number;
  readonly skewSeconds?: number;
}

const fail = (code: ChainFailureCode, step: number, reason: string): ChainFailure => ({
  ok: false,
  code,
  step,
  reason,
});

/** Digest over the compact JWS bytes, which is what the signature covers. */
export const hashJws = (compact: string): string => digestB64u(utf8(compact));

export async function verifyChain(input: ChainInput, options: ChainOptions): Promise<ChainResult> {
  const skew = options.skewSeconds ?? CLOCK_SKEW_SECONDS;
  const { now } = options;

  // ---- Step 1: the open mandate, against a pinned key -------------------
  //
  // `verify` takes the key as an argument and has no resolution callback, so
  // there is no path by which the token influences which key checks it.

  let openPayload: unknown;
  try {
    const verified = await verify(input.openJws, options.issuerKey, OPEN_MANDATE_TYP);
    openPayload = verified.payload;
  } catch (cause) {
    return fail(
      "open_signature_invalid",
      1,
      `open mandate does not verify against the pinned issuer key: ${(cause as Error).message}`,
    );
  }

  const openParsed = OpenMandateSchema.safeParse(openPayload);
  if (!openParsed.success) {
    return fail("malformed", 1, `open mandate claims are invalid: ${summarize(openParsed.error)}`);
  }
  const open = openParsed.data;

  if (open.aud !== input.audience) {
    return fail(
      "claims_disagree",
      1,
      `open mandate is addressed to ${open.aud}, not to ${input.audience}`,
    );
  }
  if (now + skew < open.nbf) return fail("not_yet_valid", 1, "open mandate is not yet valid");
  if (now - skew >= open.exp) return fail("expired", 1, "open mandate has expired");

  // ---- Step 2: the closed mandate, against the endorsed agent key -------
  //
  // The key comes from the open mandate, which step 1 just authenticated
  // against a pinned key. That is what makes it safe to use here, and why
  // this cannot run before step 1.

  let agentKey: PublicKeyRef;
  try {
    agentKey = await importPublicKey(open.cnf.jwk as never, "ES256");
  } catch (cause) {
    return fail("malformed", 2, `endorsed agent key is unusable: ${(cause as Error).message}`);
  }

  let closedPayload: unknown;
  try {
    const verified = await verify(input.closedJws, agentKey, CLOSED_MANDATE_TYP);
    closedPayload = verified.payload;
  } catch (cause) {
    return fail(
      "closed_signature_invalid",
      2,
      `closed mandate does not verify against the agent key endorsed by the open mandate: ${
        (cause as Error).message
      }`,
    );
  }

  const closedParsed = ClosedMandateSchema.safeParse(closedPayload);
  if (!closedParsed.success) {
    return fail(
      "malformed",
      2,
      `closed mandate claims are invalid: ${summarize(closedParsed.error)}`,
    );
  }
  const closed = closedParsed.data;

  if (now + skew < closed.iat) return fail("not_yet_valid", 2, "closed mandate is not yet valid");
  if (now - skew >= closed.exp) return fail("expired", 2, "closed mandate has expired");

  // ---- Step 3: upward binding -------------------------------------------

  const openHash = hashJws(input.openJws);
  if (closed.parent_hash !== openHash) {
    // A closed mandate lifted from another exchange and replayed under this
    // open mandate dies here.
    return fail(
      "parent_binding_invalid",
      3,
      "closed mandate names a different parent than the open mandate presented",
    );
  }

  if (closed.chain_depth !== MAX_CHAIN_DEPTH) {
    return fail("malformed", 3, `chain depth must be exactly ${MAX_CHAIN_DEPTH}`);
  }

  // ---- Step 4: claims both artifacts carry must agree --------------------

  if (closed.sub !== open.sub) {
    // Without this, an agent holding a valid mandate could bill a different
    // human by editing the subject of the half it signs.
    return fail(
      "claims_disagree",
      4,
      "closed mandate names a different principal than the open mandate",
    );
  }
  if (closed.aud !== open.aud) {
    return fail("claims_disagree", 4, "closed mandate is addressed elsewhere");
  }
  if (closed.nonce !== input.expectedNonce) {
    return fail("claims_disagree", 4, "nonce does not match the one issued for this exchange");
  }

  // ---- Step 5: attenuation -----------------------------------------------
  //
  // Absence of the array means "inherit the parent's set", which grants
  // nothing. A present array is a claim, and is checked.

  if (closed.constraints !== undefined) {
    const attenuation = narrows(open.constraints, closed.constraints);
    if (!attenuation.ok) {
      return fail("not_attenuated", 5, `${attenuation.reason} (${attenuation.constraint})`);
    }
  }

  // ---- Step 6: the cart ---------------------------------------------------
  //
  // Hashed from OUR checkout. The agent's copy is never an input to this.

  const requestHash = digestB64u(canonicalBytes(input.checkout));
  if (closed.request_hash !== requestHash) {
    return fail(
      "request_binding_invalid",
      6,
      "closed mandate is bound to a different cart than the one being paid for",
    );
  }

  return {
    ok: true,
    open,
    closed,
    openHash,
    closedHash: hashJws(input.closedJws),
    constraints: effective(open.constraints, closed.constraints ?? []),
  };
}

/**
 * A one-line summary of a validation failure.
 *
 * Deliberately terse and structural. These strings reach logs and protocol
 * responses, and a mandate payload can carry a purpose string and a principal
 * id, so echoing values back is a disclosure risk.
 */
function summarize(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Header and payload of a mandate, WITHOUT signature verification. */
export const peek = decodeUnsafe;
