/**
 * The composed purchase: gate, spend, audit and outbox in one motion.
 *
 * One transaction covers the nonce burn, the spend lock, the audit record,
 * the payment intent and the idempotency completion. If any of those could
 * commit while another rolled back, either we would charge a refusal, log a
 * spend that never happened, or replay an answer that disagrees with the
 * money. A crash mid-purchase rolls all of it back — including the nonce —
 * so a transient failure does not brick the (nonce, closed mandate) pair.
 */

import { z } from "zod";
import { append } from "../audit/log.js";
import { type AuditRecord, toPaise } from "../audit/record.js";
import type { JsonValue } from "../crypto/canonical.js";
import { digestJson } from "../crypto/digest.js";
import type { PublicKeyRef } from "../crypto/keys.js";
import { type Sql, type TransactionSql, withTxn } from "../db/client.js";
import { AgentProposalSchema, type Cart, gate } from "../gate/accept.js";
import { claim, complete, release } from "../http/idempotency.js";
import { ensureAccounts } from "../ledger/ledger.js";
import type { Constraint } from "../mandate/constraints.js";
import { verifyChain } from "../mandate/verify.js";
import { CURRENCIES, money } from "../money/money.js";
import { ENGINE_VERSION } from "../policy/engine.js";
import { deriveReceipt } from "../razorpay/receipt.js";
import { intendPayment } from "../razorpay/settle.js";
import { attemptSpend } from "../spend/accounting.js";
import { consume } from "../spend/nonce.js";

// Every string is bounded and free of control characters. The route is
// unauthenticated and the idempotency row commits before the mandate is
// verified, so an unbounded field is a storage amplifier: one garbage
// request, one arbitrarily large row. A NUL byte would reach Postgres and
// surface as an internal error rather than a refusal at the boundary.
const hasControl = (value: string): boolean => {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasControl(v), "control characters are not allowed");

export const CartSchema = z
  .object({
    total_paise: z.number().int().nonnegative(),
    currency: z.enum(CURRENCIES),
    payee: z.object({ id: text(128) }).strict(),
    rail: text(64),
    category: text(64).optional(),
  })
  .strict();

export const PurchaseBodySchema = z
  .object({
    actor_id: text(128),
    nonce: text(128).refine((v) => v.length >= 16, "nonce is too short"),
    open_jws: z.string().min(1).max(8192),
    closed_jws: z.string().min(1).max(8192),
    cart: CartSchema,
    proposal: AgentProposalSchema,
    // Deliberately no human_approved flag: an unauthenticated request body
    // must not be able to strip the signed escalation constraint. The
    // library-level resume path (attemptSpend's humanApproved) exists for a
    // future authenticated approval surface, not for this route.
  })
  .strict();

export type PurchaseBody = z.infer<typeof PurchaseBodySchema>;

export const NonceBodySchema = z.object({ issued_to: text(128) }).strict();

export interface PurchaseInput {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  readonly openJws: string;
  readonly closedJws: string;
  readonly cart: Cart;
  readonly proposal: unknown;
  readonly authorizationId: string;
  readonly outboxId: string;
  readonly now: number;
  readonly audience: string;
  readonly issuer: PublicKeyRef;
  /** Canonical request body used as the idempotency fingerprint. */
  readonly fingerprint: JsonValue;
}

export interface PurchaseResponse {
  readonly status: number;
  readonly body: JsonValue;
}

export async function purchase(sql: Sql, input: PurchaseInput): Promise<PurchaseResponse> {
  const claimed = await claim(sql, {
    actorId: input.actorId,
    key: input.idempotencyKey,
    request: input.fingerprint,
  });

  if (claimed.kind === "replay") {
    return { status: claimed.status, body: claimed.body };
  }
  if (claimed.kind === "inFlight") {
    return {
      status: 409,
      body: { outcome: "in_flight", retry_after_seconds: claimed.retryAfterSeconds },
    };
  }
  if (claimed.kind === "mismatch") {
    return { status: 422, body: { outcome: "mismatch", detail: "idempotency key reused" } };
  }

  try {
    const result = await execute(sql, input);
    if (result.transient === true) {
      // True of this attempt, not of the request: hand the key back so the
      // retry the client is about to make re-executes instead of replaying
      // a contention answer for the whole retention window.
      await release(sql, input.actorId, input.idempotencyKey);
      return { status: result.status, body: result.body };
    }
    if (!result.completed) {
      await complete(sql, input.actorId, input.idempotencyKey, result.status, result.body);
    }
    return { status: result.status, body: result.body };
  } catch (error) {
    try {
      // An internal error is not an answer to record; recording it would
      // replay a 500 to every retry until the row was purged.
      await release(sql, input.actorId, input.idempotencyKey);
    } catch {
      // The lease reaper frees the key; the original error is the one to keep.
    }
    throw error;
  }
}

interface ExecutedResponse extends PurchaseResponse {
  /** True when the idempotency row was completed inside the transaction. */
  readonly completed: boolean;
  /** True for an outcome that must not be stored against the key. */
  readonly transient?: boolean;
}

/** AP2's one-in-flight rule refused us. Nothing was authorised; roll it all back. */
class Contention extends Error {
  constructor(readonly openJti: string) {
    super(`mandate ${openJti} already has an authorization in flight`);
    this.name = "Contention";
  }
}

async function execute(sql: Sql, input: PurchaseInput): Promise<ExecutedResponse> {
  const checkout = cartAsCheckout(input.cart);

  const chain = await verifyChain(
    {
      openJws: input.openJws,
      closedJws: input.closedJws,
      checkout,
      expectedNonce: input.nonce,
      audience: input.audience,
    },
    { issuerKey: input.issuer, now: input.now },
  );

  if (!chain.ok) {
    return {
      status: 400,
      body: { outcome: "rejected", at: "mandate", code: chain.code, detail: chain.reason },
      completed: false,
    };
  }

  if (
    chain.closed.amount.amount !== BigInt(input.cart.total_paise) ||
    chain.closed.payee.id !== input.cart.payee.id
  ) {
    return {
      status: 400,
      body: { outcome: "rejected", at: "cart_binding", detail: "closed claims do not match cart" },
      completed: false,
    };
  }

  // The same receipt `intendPayment` derives, recorded in the audit log so
  // the verifier can re-derive it from the mandate (checks R2/R3).
  const receipt = deriveReceipt(chain.closed.jti, chain.closed.request_hash);
  const toolArgs = { amount: input.cart.total_paise, currency: input.cart.currency, receipt };
  const budget = chain.constraints.find(
    (c): c is Extract<Constraint, { type: "spend.budget" }> =>
      c.type === "spend.budget" && c.currency === input.cart.currency,
  );

  const request = {
    amount: money(BigInt(input.cart.total_paise), input.cart.currency),
    payee: input.cart.payee,
    rail: input.cart.rail,
    ...(input.cart.category !== undefined ? { category: input.cart.category } : {}),
  };

  // Everything that writes runs in ONE transaction. A deliberate refusal
  // (bad proposal, policy deny) COMMITS — it burns the nonce and holds the
  // replay guard, or an agent could retry a refusal until room appeared. An
  // unexpected error THROWS — everything rolls back, the nonce included.
  // Contention (another authorization already in flight) also rolls back:
  // it is not a verdict on this purchase, so burning the nonce would strand
  // a legitimate retry at the nonce check.
  try {
    return await withTxn(sql, async (tx) => {
      const redeemed = await consume(tx, input.nonce);
      if (!redeemed.ok) {
        return respond(tx, input, 400, {
          outcome: "rejected",
          at: "nonce",
          detail: redeemed.reason,
        });
      }

      // Schema and cart binding only. The decision is made exactly once, under
      // the spend lock inside attemptSpend, on real accounting state.
      const gated = gate(input.cart, input.proposal);
      if (gated.outcome === "rejected") {
        return respond(tx, input, 400, { outcome: "rejected", at: gated.at, detail: gated.detail });
      }

      await ensureAccounts(tx, input.cart.currency);

      // The audit record commits to hashes; a third-party verifier needs the
      // artifacts themselves — the raw JWSes to re-verify signatures and the
      // checkout to re-derive request_hash. Stored in the same transaction as
      // the decision so an exported bundle is assembled from rows that
      // committed together with the record they substantiate.
      await tx`
			INSERT INTO mandate_artifacts (closed_jti, open_jti, open_jws, closed_jws, nonce, checkout, request)
			VALUES (
				${chain.closed.jti}, ${chain.open.jti}, ${input.openJws}, ${input.closedJws},
				${input.nonce}, ${tx.json(checkout as never)},
				${tx.json({
          amount_paise: input.cart.total_paise,
          currency: input.cart.currency,
          payee: { id: input.cart.payee.id },
          rail: input.cart.rail,
        } as never)}
			)
			ON CONFLICT (closed_jti) DO NOTHING
		`;

      // Set inside onDecision, which runs for ALLOW, DENY and ESCALATE alike —
      // a refusal is as much a money action as a permit, and both must land in
      // the log in the same transaction as the accounting they describe.
      let audit: AuditRecord | undefined;

      const result = await attemptSpend(tx, {
        openJti: chain.open.jti,
        closedJti: chain.closed.jti,
        constraints: chain.constraints,
        request,
        now: input.now,
        authorizationId: input.authorizationId,
        onDecision: async (tx, accounting) => {
          const effect = accounting.decision.effect;
          audit = await append(tx, {
            ts: new Date(input.now * 1000).toISOString(),
            trace_id: input.authorizationId,
            actor: {
              principal_id: chain.open.sub,
              agent_id: chain.closed.agent.id,
              agent_version: chain.closed.agent.version,
              model: chain.closed.agent.model,
              runtime_sha256: chain.closed.agent.runtime_sha256,
            },
            mandate: {
              open_jti: chain.open.jti,
              open_hash: chain.openHash,
              closed_jti: chain.closed.jti,
              closed_hash: chain.closedHash,
              chain_depth: chain.closed.chain_depth,
            },
            intent: gated.prompt,
            tool: {
              name: "razorpay.orders.create",
              args: toolArgs,
              args_sha256: digestJson(toolArgs),
            },
            policy: {
              bundle_sha256: chain.open.policy_bundle_sha256,
              engine_version: ENGINE_VERSION,
              rules_evaluated: accounting.decision.rules.map((r) => ({
                id: r.id,
                constraint: r.constraint,
                effect: r.effect,
              })),
              first_deny: accounting.decision.decidedBy,
            },
            accounting: {
              spent_before_paise: toPaise(accounting.spentBefore.amount),
              amount_paise: toPaise(accounting.amount.amount),
              spent_after_paise: toPaise(accounting.spentAfter.amount),
              actions_before: accounting.actionsBefore,
              actions_after: accounting.actionsAfter,
              budget_max_paise: budget === undefined ? null : toPaise(budget.max),
              currency: input.cart.currency,
            },
            decision: effect === "permit" ? "ALLOW" : effect === "deny" ? "DENY" : "ESCALATE",
            reason: accounting.decision.reason,
            external:
              effect === "permit"
                ? {
                    rail: "razorpay",
                    idempotency_key: input.idempotencyKey,
                    order_id: null,
                    payment_id: null,
                    signature_verified: false,
                    status: "intended",
                  }
                : null,
            output_sha256: null,
          });

          if (effect !== "permit") return;
          await intendPayment(tx, {
            authorizationId: input.authorizationId,
            openJti: chain.open.jti,
            closedJti: chain.closed.jti,
            requestHash: chain.closed.request_hash,
            amountMinor: request.amount.amount,
            currency: request.amount.currency,
            outboxId: input.outboxId,
          });
        },
      });

      const auditRef =
        audit === undefined ? {} : { audit: { seq: audit.seq, record_hash: audit.record_hash } };

      if (result.outcome === "permitted") {
        return respond(tx, input, 200, {
          outcome: "permitted",
          authorization_id: result.authorizationId,
          closed_jti: chain.closed.jti,
          receipt,
          ...auditRef,
        });
      }
      if (result.outcome === "already_in_flight") throw new Contention(result.openJti);
      if (result.outcome === "replayed") {
        return respond(tx, input, 409, { outcome: "replayed", closed_jti: result.closedJti });
      }
      if (result.outcome === "escalate") {
        return respond(tx, input, 403, {
          outcome: "escalate",
          reason: result.decision.reason,
          decided_by: result.decision.decidedBy,
          ...auditRef,
        });
      }
      return respond(tx, input, 403, {
        outcome: "denied",
        reason: result.decision.reason,
        decided_by: result.decision.decidedBy,
        ...auditRef,
      });
    });
  } catch (error) {
    if (error instanceof Contention) {
      return {
        status: 409,
        body: { outcome: "already_in_flight", open_jti: error.openJti, retry_after_seconds: 2 },
        completed: false,
        transient: true,
      };
    }
    throw error;
  }
}

/**
 * Store the response under the idempotency key INSIDE the transaction, so
 * the answer a retry replays can never disagree with what actually
 * committed. A crash before commit leaves the key in flight; the lease
 * expires and the retry re-executes against a fully rolled-back world.
 */
async function respond(
  tx: TransactionSql,
  input: PurchaseInput,
  status: number,
  body: JsonValue,
): Promise<ExecutedResponse> {
  await complete(tx, input.actorId, input.idempotencyKey, status, body);
  return { status, body, completed: true };
}

export function cartAsCheckout(cart: Cart): JsonValue {
  const checkout: { [key: string]: JsonValue } = {
    total_paise: cart.total_paise,
    currency: cart.currency,
    payee: { id: cart.payee.id },
    rail: cart.rail,
  };
  if (cart.category !== undefined) checkout.category = cart.category;
  return checkout;
}
