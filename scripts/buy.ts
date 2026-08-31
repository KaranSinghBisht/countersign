/**
 * One real purchase through the running server, as a buyer agent makes it.
 *
 *   make buy                              # ₹14,990 — permitted
 *   make buy ARGS="--amount 6000000"      # above the per-transaction cap — denied
 *   make buy ARGS="--escalate"            # above a signed threshold — escalate
 *
 * Signs the open mandate with MANDATE_ISSUER_JWK (standing in for the human's
 * consent surface) and the closed mandate with AGENT_SIGNING_JWK, both from
 * .env, then walks POST /nonce → POST /purchase against COUNTERSIGN_BASE_URL
 * (or --server <url> to reach the same deployment at another address).
 * Nothing here bypasses the gate: this is the reference client for /agents.md,
 * and every step it prints is one an agent would perform.
 */

import { ulid } from "ulid";
import { decodeEnvJwk } from "../src/config.js";
import { canonicalBytes, type JsonValue } from "../src/crypto/canonical.js";
import { digestB64u } from "../src/crypto/digest.js";
import { sign } from "../src/crypto/jws.js";
import { importPrivateKey } from "../src/crypto/keys.js";
import {
  CLOSED_MANDATE_TYP,
  CLOSED_MANDATE_VCT,
  OPEN_MANDATE_TYP,
  OPEN_MANDATE_VCT,
} from "../src/mandate/types.js";
import { hashJws } from "../src/mandate/verify.js";
import { cartAsCheckout } from "../src/payments/purchase.js";

const out = (line: string): void => void process.stdout.write(`${line}\n`);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`${name} is not set — run make setup, then make buy\n`);
    process.exit(2);
  }
  return value;
}

// The audience is the deployment's public base URL, which the server pins in
// every mandate; the HTTP target may differ (a port-forward, 127.0.0.1)
// without changing what the mandate is addressed to.
const audience = (flag("--audience") ?? required("COUNTERSIGN_BASE_URL")).replace(/\/+$/, "");
const server = (flag("--server") ?? audience).replace(/\/+$/, "");
const amount = Number(flag("--amount") ?? 1_499_000);
const escalate = process.argv.includes("--escalate");
if (!Number.isInteger(amount) || amount < 0) {
  process.stderr.write("--amount must be a non-negative integer of paise\n");
  process.exit(2);
}

const issuer = await importPrivateKey(decodeEnvJwk(required("MANDATE_ISSUER_JWK")), "ES256");
const agentJwk = decodeEnvJwk(required("AGENT_SIGNING_JWK"));
const agent = await importPrivateKey(agentJwk, "ES256");

const cart = {
  total_paise: escalate ? Math.max(amount, 2_500_000) : amount,
  currency: "INR" as const,
  payee: { id: "vnd_1042" },
  rail: "razorpay_order",
};

const constraints: JsonValue[] = [
  { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 },
  { type: "spend.budget", currency: "INR", max: 25_000_000 },
  { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
  { type: "spend.rail", allowed: ["razorpay_order"] },
];
if (escalate) {
  constraints.push({
    type: "spend.escalation_threshold",
    currency: "INR",
    above: 2_000_000,
    requires: "human_approval",
  });
}

out(`buyer agent → ${server}${server === audience ? "" : ` (mandates addressed to ${audience})`}`);
out(`cart: ₹${(cart.total_paise / 100).toLocaleString("en-IN")} to ${cart.payee.id}`);

// 1. A challenge the server chose after this request began.
const issued = await fetch(`${server}/nonce`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ issued_to: "usr_8f3ac21e" }),
});
const { nonce } = (await issued.json()) as { nonce: string };
out(`1. POST /nonce            → ${issued.status}  nonce ${nonce.slice(0, 10)}…`);

// 2. The human's open mandate. Simulated consent: the issuer key stands in.
const now = Math.floor(Date.now() / 1000);
const openJws = await sign(
  {
    vct: OPEN_MANDATE_VCT,
    iss: "https://countersign.example/consent",
    sub: "usr_8f3ac21e",
    aud: audience,
    jti: ulid(),
    iat: now - 10,
    nbf: now - 10,
    exp: now + 86_400,
    cnf: {
      jwk: { kty: "EC", crv: "P-256", x: agentJwk.x, y: agentJwk.y, alg: "ES256", kid: agent.kid },
    },
    purpose: "make_buy",
    policy_bundle_sha256: digestB64u(canonicalBytes("policy")),
    constraints,
  } as JsonValue,
  issuer,
  OPEN_MANDATE_TYP,
);
out(
  `2. open mandate signed    → cap ₹50,000 · budget ₹2,50,000${escalate ? " · ask above ₹20,000" : ""}`,
);

// 3. The agent's closed mandate: ~120 s, bound to this cart and this nonce.
const closedJws = await sign(
  {
    vct: CLOSED_MANDATE_VCT,
    iss: "agent:pricing-bot",
    sub: "usr_8f3ac21e",
    aud: audience,
    jti: ulid(),
    iat: now - 2,
    exp: now + 115,
    parent_hash: hashJws(openJws),
    request_hash: digestB64u(canonicalBytes(cartAsCheckout(cart))),
    nonce,
    amount: { amount: cart.total_paise, currency: cart.currency },
    payee: cart.payee,
    agent: {
      id: "pricing-bot",
      version: "1.4.2",
      model: "claude-opus-5",
      runtime_sha256: digestB64u(canonicalBytes("runtime")),
    },
    chain_depth: 2,
  } as JsonValue,
  agent,
  CLOSED_MANDATE_TYP,
);
out("3. closed mandate signed  → bound to request_hash + nonce, 120 s to live");

// 4. The purchase. One transaction on the other side.
const response = await fetch(`${server}/purchase`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": `buy-${ulid()}` },
  body: JSON.stringify({
    actor_id: "usr_8f3ac21e",
    nonce,
    open_jws: openJws,
    closed_jws: closedJws,
    cart,
    proposal: {
      amount_paise: cart.total_paise,
      currency: cart.currency,
      payee: cart.payee,
      rail: cart.rail,
    },
  }),
});
const body = (await response.json()) as Record<string, unknown>;
out(`4. POST /purchase         → ${response.status}  ${String(body.outcome)}`);
out("");
out(JSON.stringify(body, null, 2));

const audit = body.audit as { seq?: number } | undefined;
if (audit?.seq !== undefined) {
  out("");
  out(`the log knows this purchase as seq ${audit.seq}. After the worker seals a checkpoint:`);
  out(
    `  make export && ./dist/countersign.mjs explain --bundle .countersign/live-export --seq ${audit.seq}`,
  );
}

// 5. Permitted is not paid. The worker creates the Razorpay order on its next
//    tick; once it exists, a human pays it on our payer page.
if (body.outcome === "permitted" && typeof body.receipt === "string") {
  const payUrl = await waitForOrder(body.receipt);
  out("");
  out(
    payUrl === undefined
      ? `order not created yet — open ${server}/pay/r/${body.receipt} in a moment to pay it`
      : `pay it (Razorpay test mode): ${payUrl}`,
  );
}

async function waitForOrder(receipt: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = await fetch(`${server}/pay/r/${receipt}`, { redirect: "manual" });
    if (probe.status === 302) return `${server}${probe.headers.get("location") ?? ""}`;
    if (probe.status !== 202) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}
