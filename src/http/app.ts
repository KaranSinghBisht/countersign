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
 * mismatch" against every payment provider. The parser is scoped to that
 * route so the rest of the app can still speak JSON.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { latestCheckpoint, proveInclusion, readByOrder } from "../audit/log.js";
import type { Config } from "../config.js";
import { hex } from "../crypto/encoding.js";
import type { Sql } from "../db/client.js";
import { ingest } from "../razorpay/webhook.js";

export interface AppDeps {
  readonly sql: Sql;
  readonly config: Pick<Config, "RAZORPAY_WEBHOOK_SECRET">;
  readonly now?: () => number;
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
      });

      return reply.code(result.status).send(result);
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
