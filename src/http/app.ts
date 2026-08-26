/**
 * HTTP surface.
 *
 * Two things here have to be right or everything else is theatre:
 *
 *   the webhook route sees the RAW BODY, because that is what the signature
 *   covers;
 *
 *   the audit routes serve what we already stored, they do not re-derive it.
 *
 * A global JSON parser above the webhook is the #1 cause of "signature
 * mismatch" against every payment provider. JSON parsing is scoped to the
 * purchase plugin so the webhook child keeps a Buffer.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { latestCheckpoint, proveInclusion, readByOrder } from "../audit/log.js";
import type { Config } from "../config.js";
import type { JsonValue } from "../crypto/canonical.js";
import { hex } from "../crypto/encoding.js";
import type { PublicKeyRef } from "../crypto/keys.js";
import type { Sql } from "../db/client.js";
import { NonceBodySchema, PurchaseBodySchema, purchase } from "../payments/purchase.js";
import { ingest } from "../razorpay/webhook.js";
import { issue } from "../spend/nonce.js";

export interface AppDeps {
  readonly sql: Sql;
  readonly config: Pick<Config, "RAZORPAY_WEBHOOK_SECRET"> &
    Partial<Pick<Config, "WEBHOOK_MAX_AGE_SECONDS" | "COUNTERSIGN_BASE_URL">>;
  readonly now?: () => number;
  readonly issuer?: PublicKeyRef;
  readonly audience?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Razorpay's 5s timeout is the budget. A body larger than this is not a
    // webhook, it is an attack.
    bodyLimit: 256 * 1024,
  });

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post("/webhooks/razorpay", async (request, reply) => {
      const raw = request.body;
      if (!(raw instanceof Buffer)) {
        return reply.code(400).send({ outcome: "malformed", detail: "expected a raw body" });
      }

      const result = await ingest(deps.sql, {
        rawBody: new Uint8Array(raw),
        signature: header(request.headers["x-razorpay-signature"]),
        eventId: header(request.headers["x-razorpay-event-id"]),
        secret: deps.config.RAZORPAY_WEBHOOK_SECRET,
        now: deps.now?.() ?? Math.floor(Date.now() / 1000),
        ...(deps.config.WEBHOOK_MAX_AGE_SECONDS !== undefined
          ? { maxAgeSeconds: deps.config.WEBHOOK_MAX_AGE_SECONDS }
          : {}),
      });

      return reply.code(result.status).send(result);
    });
  });

  await app.register(async (scope) => {
    // /nonce and /purchase are unauthenticated and each request costs a row
    // and real verification work. The limit is per-IP and generous — a
    // legitimate buyer agent retries a handful of times, not twice a second
    // for a minute. Scoped here so webhooks (authenticated by signature and
    // retried on a schedule Razorpay controls) are never throttled.
    await scope.register(rateLimit, {
      max: 120,
      timeWindow: "1 minute",
    });

    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          // Without a statusCode Fastify reports a parser failure as a 500,
          // which reads as our bug rather than the caller's malformed body.
          done(Object.assign(new Error("body is not valid JSON"), { statusCode: 400 }));
        }
      },
    );

    scope.post("/nonce", async (request, reply) => {
      const parsed = NonceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ outcome: "malformed", detail: "issued_to is required" });
      }
      const issued = await issue(deps.sql, parsed.data.issued_to);
      return reply.code(200).send({
        nonce: issued.nonce,
        expires_at: issued.expiresAt.toISOString(),
      });
    });

    scope.post("/purchase", async (request, reply) => {
      if (deps.issuer === undefined || deps.audience === undefined) {
        return reply.code(503).send({ outcome: "unavailable", detail: "issuer is not configured" });
      }

      const idempotencyKey = header(request.headers["idempotency-key"]);
      if (idempotencyKey === undefined || idempotencyKey.length === 0) {
        return reply
          .code(400)
          .send({ outcome: "malformed", detail: "Idempotency-Key is required" });
      }

      const parsed = PurchaseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          outcome: "malformed",
          detail: parsed.error.issues
            .slice(0, 4)
            .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
            .join("; "),
        });
      }

      const body = parsed.data;
      const result = await purchase(deps.sql, {
        actorId: body.actor_id,
        idempotencyKey,
        nonce: body.nonce,
        openJws: body.open_jws,
        closedJws: body.closed_jws,
        cart: {
          total_paise: body.cart.total_paise,
          currency: body.cart.currency,
          payee: body.cart.payee,
          rail: body.cart.rail,
          ...(body.cart.category !== undefined ? { category: body.cart.category } : {}),
        },
        proposal: body.proposal,
        authorizationId: ulid(),
        outboxId: ulid(),
        now: deps.now?.() ?? Math.floor(Date.now() / 1000),
        audience: deps.audience,
        issuer: deps.issuer,
        fingerprint: request.body as JsonValue,
      });

      if (
        result.status === 409 &&
        typeof result.body === "object" &&
        result.body !== null &&
        "retry_after_seconds" in result.body
      ) {
        const retry = (result.body as { retry_after_seconds: number }).retry_after_seconds;
        reply.header("retry-after", String(retry));
      }

      return reply.code(result.status).send(result.body);
    });
  });

  app.get("/audit/checkpoint", async (_request, reply) => {
    const latest = await latestCheckpoint(deps.sql);
    if (latest === undefined) return reply.code(404).send({ error: "no checkpoint published" });

    return {
      origin: latest.checkpoint.origin,
      size: latest.checkpoint.size,
      root: hex(latest.checkpoint.rootHash),
      note: latest.note,
      created_at: latest.createdAt.toISOString(),
    };
  });

  app.get<{ Querystring: { seq?: string } }>("/audit/proof", async (request, reply) => {
    const seq = Number(request.query.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      return reply.code(400).send({ error: "seq must be a non-negative integer" });
    }

    try {
      const evidence = await proveInclusion(deps.sql, seq);
      return {
        seq: evidence.seq,
        tree_size: evidence.treeSize,
        leaf_hash: hex(evidence.leafHash),
        root: hex(evidence.root),
        proof: evidence.proof.map(hex),
      };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/audit/orders/:id", async (request, reply) => {
    const records = await readByOrder(deps.sql, request.params.id);
    if (records.length === 0) return reply.code(404).send({ error: "no records for that order" });
    return { order_id: request.params.id, records };
  });

  return app;
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
