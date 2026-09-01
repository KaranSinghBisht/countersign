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

import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ulid } from "ulid";
import { latestCheckpoint, proveConsistency, proveInclusion, readByOrder } from "../audit/log.js";
import type { Config } from "../config.js";
import type { JsonValue } from "../crypto/canonical.js";
import { hex } from "../crypto/encoding.js";
import type { PublicKeyRef } from "../crypto/keys.js";
import type { Sql } from "../db/client.js";
import { NonceBodySchema, PurchaseBodySchema, purchase } from "../payments/purchase.js";
import { ingest } from "../razorpay/webhook.js";
import { issue } from "../spend/nonce.js";
import { agentsMd, llmsTxt } from "./pages/agents.js";
import { architectureHtml } from "./pages/architecture.js";
import { heroPoster, heroVideo, landingAssets } from "./pages/assets.js";
import { landingScript, renderLanding } from "./pages/landing.js";
import { registerPay } from "./pay.js";

// The landing page's one inline script, allowed by its exact hash so the
// default CSP needs no 'unsafe-inline' for scripts anywhere.
const LANDING_SCRIPT_SHA256 = createHash("sha256").update(landingScript, "utf8").digest("base64");

export interface AppDeps {
  readonly sql: Sql;
  readonly config: Pick<Config, "RAZORPAY_WEBHOOK_SECRET"> &
    Partial<
      Pick<
        Config,
        | "WEBHOOK_MAX_AGE_SECONDS"
        | "COUNTERSIGN_BASE_URL"
        | "RAZORPAY_KEY_ID"
        | "RAZORPAY_KEY_SECRET"
        | "RAZORPAY_MODE"
      >
    >;
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
    // A malformed URL never reaches the error handler below; without this it
    // answers in Fastify's own envelope, the one shape /agents.md never lists.
    frameworkErrors: (_error, _request, reply) => {
      (reply as FastifyReply)
        .code(400)
        .send({ outcome: "rejected", at: "schema", detail: "malformed request" });
    },
  });

  // Every error leaves in the contract's own shape. Without this, a body that
  // is not JSON surfaces Fastify's default envelope, a 5xx could carry a
  // message an agent should never see, and /agents.md would be lying about
  // the one thing an implementer parses first.
  app.setErrorHandler((error: { statusCode?: number; message?: string }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ outcome: "rate_limited", detail: error.message ?? "" });
    }
    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ outcome: "rejected", at: "schema", detail: error.message ?? "" });
    }
    return reply.code(500).send({ outcome: "error", detail: "internal" });
  });

  // An unknown path answers in the contract's envelope too — Fastify's
  // default 404 body is the one shape /agents.md never lists.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ outcome: "rejected", at: "schema", detail: "no such route" });
  });

  // Defense-in-depth headers on every response. The landing page is a fixed
  // server-rendered string, so the CSP mostly says what it already is: same
  // origin, inline style, exactly one inline script (pinned by hash, not
  // 'unsafe-inline'), no framing anywhere.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    const type = String(reply.getHeader("content-type") ?? "");
    // A route that must load something external (the payer page loads
    // Razorpay Checkout) sets its own, narrower-than-default-elsewhere policy.
    if (type.startsWith("text/html") && !reply.hasHeader("content-security-policy")) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; img-src 'self' data:; media-src 'self'; " +
          `style-src 'self' 'unsafe-inline'; script-src 'sha256-${LANDING_SCRIPT_SHA256}'; ` +
          "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
      );
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  // The human who pays the order the agent was allowed to place.
  await registerPay(app, { sql: deps.sql, config: deps.config });

  // Discovery documents: the front door for humans and the contract for buyer
  // agents. Rendered ONCE here (the base URL only feeds absolute link-preview
  // meta) — no database read, no per-request templating — so they render
  // identically offline and cannot leak state. GETs, so they sit outside
  // every body parser and rate-limit scope.
  const landingHtml = renderLanding(deps.config.COUNTERSIGN_BASE_URL ?? "");
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(landingHtml));
  app.get("/agents.md", async (_request, reply) =>
    reply.type("text/markdown; charset=utf-8").send(agentsMd),
  );
  app.get("/llms.txt", async (_request, reply) =>
    reply.type("text/plain; charset=utf-8").send(llmsTxt),
  );
  app.get("/architecture", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(architectureHtml),
  );

  // Safari refuses to play media from a server that ignores Range requests,
  // so the single-range handling here is a requirement, not an optimization.
  app.get("/hero-video.mp4", async (request, reply) => {
    const size = heroVideo.byteLength;
    reply.header("accept-ranges", "bytes").header("cache-control", "public, max-age=86400");

    const range = header(request.headers.range);
    const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match !== null && (match[1] !== "" || match[2] !== "")) {
      const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
      const end =
        match[2] === "" || match[1] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
      if (start > end || start >= size) {
        return reply.code(416).header("content-range", `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .type("video/mp4")
        .send(heroVideo.subarray(start, end + 1));
    }
    return reply.type("video/mp4").send(heroVideo);
  });

  app.get("/hero-poster.jpg", async (_request, reply) =>
    reply.type("image/jpeg").header("cache-control", "public, max-age=86400").send(heroPoster),
  );

  // Pixel-art accents for the landing page. The map is a boot-time allowlist,
  // so :name is a lookup key — an unknown name is a 404, never a disk read.
  app.get<{ Params: { name: string } }>("/assets/:name", async (request, reply) => {
    const asset = landingAssets.get(request.params.name);
    if (asset === undefined) return reply.code(404).send({ error: "no such asset" });
    return reply.type(asset.type).header("cache-control", "public, max-age=86400").send(asset.data);
  });

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

    // Route-level body limits: the global 256 KB is the webhook's budget, not
    // a nonce request's. A purchase carries two JWSes and a cart — 32 KB is
    // generous; anything larger is not a buyer.
    scope.post("/nonce", { bodyLimit: 1024 }, async (request, reply) => {
      const parsed = NonceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ outcome: "rejected", at: "schema", detail: "issued_to is required" });
      }
      const issued = await issue(deps.sql, parsed.data.issued_to);
      return reply.code(200).send({
        nonce: issued.nonce,
        expires_at: issued.expiresAt.toISOString(),
      });
    });

    scope.post("/purchase", { bodyLimit: 32 * 1024 }, async (request, reply) => {
      if (deps.issuer === undefined || deps.audience === undefined) {
        return reply.code(503).send({ outcome: "unavailable", detail: "issuer is not configured" });
      }

      const idempotencyKey = header(request.headers["idempotency-key"]);
      if (
        idempotencyKey === undefined ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 200
      ) {
        return reply
          .code(400)
          .send({ outcome: "rejected", at: "schema", detail: "Idempotency-Key is required" });
      }

      const parsed = PurchaseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          outcome: "rejected",
          at: "schema",
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

  // Public and read-only, but a scope of its own: each proof walks the log
  // prefix, and an unthrottled scraper would turn that into a CPU bill.
  await app.register(async (scope) => {
    await scope.register(rateLimit, { max: 60, timeWindow: "1 minute" });

    scope.get("/audit/checkpoint", async (_request, reply) => {
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

    // Proofs are against the latest SIGNED root, never the unsigned tip: a
    // proof nobody has committed to proves nothing to a third party. A record
    // past the sealed prefix is "not yet sealed" until the worker's next tick.
    scope.get<{ Querystring: { seq?: string } }>("/audit/proof", async (request, reply) => {
      if (!/^\d{1,12}$/.test(request.query.seq ?? "")) {
        return reply.code(400).send({ error: "seq must be a non-negative integer" });
      }
      const seq = Number(request.query.seq);
      const latest = await latestCheckpoint(deps.sql);
      if (latest === undefined) return reply.code(404).send({ error: "no checkpoint published" });
      if (seq >= latest.checkpoint.size) {
        return reply.code(404).send({
          error:
            `seq ${seq} is not yet sealed by a checkpoint (sealed size ` +
            `${latest.checkpoint.size}); retry after the next worker tick`,
        });
      }

      const evidence = await proveInclusion(deps.sql, seq, latest.checkpoint.size);
      return {
        seq,
        tree_size: latest.checkpoint.size,
        leaf_hash: hex(evidence.leafHash),
        root: hex(evidence.root),
        proof: evidence.proof.map(hex),
        checkpoint_note: latest.note,
      };
    });

    // Consistency between an earlier sealed size and the latest: the proof
    // that the log only ever grew, which is the claim an audit log makes.
    scope.get<{ Querystring: { from?: string } }>("/audit/consistency", async (request, reply) => {
      if (!/^\d{1,12}$/.test(request.query.from ?? "")) {
        return reply.code(400).send({ error: "from must be a non-negative integer" });
      }
      const from = Number(request.query.from);
      const latest = await latestCheckpoint(deps.sql);
      if (latest === undefined) return reply.code(404).send({ error: "no checkpoint published" });
      if (from > latest.checkpoint.size) {
        return reply
          .code(404)
          .send({ error: `from ${from} exceeds the sealed size ${latest.checkpoint.size}` });
      }

      const { proof } = await proveConsistency(deps.sql, from, latest.checkpoint.size);
      return {
        from,
        to: latest.checkpoint.size,
        root: hex(latest.checkpoint.rootHash),
        proof: proof.map(hex),
        checkpoint_note: latest.note,
      };
    });

    scope.get<{ Params: { id: string } }>("/audit/orders/:id", async (request, reply) => {
      // Razorpay ids are short and alphanumeric; anything else is refused at
      // the boundary rather than handed to Postgres to choke on.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.params.id)) {
        return reply.code(400).send({ error: "order id must be 1–64 characters of [A-Za-z0-9_-]" });
      }
      const records = await readByOrder(deps.sql, request.params.id);
      if (records.length === 0) return reply.code(404).send({ error: "no records for that order" });
      return { order_id: request.params.id, records };
    });
  });

  return app;
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
