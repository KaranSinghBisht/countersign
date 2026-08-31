/**
 * A signed honest bundle, used by the tamper and omission rehearsals.
 *
 * Built the same way the verifier tests build one, so a judge who then runs
 * the unit tests is looking at the same bytes.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { sign as signCheckpoint } from "../audit/checkpoint.js";
import { inclusionProof, leafHash, root } from "../audit/merkle.js";
import { GENESIS_HASH, seal, type UnsealedRecord } from "../audit/record.js";
import type { JsonValue } from "../crypto/canonical.js";
import { canonicalBytes } from "../crypto/canonical.js";
import { digestB64u, digestString } from "../crypto/digest.js";
import { b64u, hex, utf8 } from "../crypto/encoding.js";
import { sign } from "../crypto/jws.js";
import { generateKey, type KeyPair } from "../crypto/keys.js";
import { ConstraintSchema } from "../mandate/constraints.js";
import {
  CLOSED_MANDATE_TYP,
  CLOSED_MANDATE_VCT,
  OPEN_MANDATE_TYP,
  OPEN_MANDATE_VCT,
} from "../mandate/types.js";
import { hashJws } from "../mandate/verify.js";
import { money } from "../money/money.js";
import { decide } from "../policy/engine.js";
import { deriveReceipt } from "../razorpay/receipt.js";
import type { CheckoutFile, ReceiptFile } from "../verify/bundle.js";
import { writeBundle } from "../verify/export.js";

export const ORIGIN = "countersign.dev/audit";
export const AUDIENCE = "https://countersign.example/agent-commerce";
export const NOW = 1_755_700_500;
export const DIGEST = digestString("fixture");

export const CHECKOUT: JsonValue = {
  cart_id: "01K3QF9AAA0P6QW1E4RT7YABCD",
  currency: "INR",
  lines: [{ sku: "SKU-118", qty: 2, unit_paise: 749_500 }],
  total_paise: 1_499_000,
};

const CONSTRAINTS = [
  { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 },
  { type: "spend.budget", currency: "INR", max: 25_000_000 },
  { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
  { type: "spend.rail", allowed: ["razorpay_order"] },
];

export interface SampleKeys {
  readonly issuer: KeyPair;
  readonly agent: KeyPair;
  readonly checkpoint: KeyPair;
}

export interface SampleWorld {
  readonly keys: SampleKeys;
  readonly openJti: string;
  readonly closedJti: string;
  readonly openJws: string;
  readonly closedJws: string;
  readonly nonce: string;
  readonly receipt: string;
  readonly record: ReturnType<typeof seal>;
  readonly note: string;
  readonly receiptFile: ReceiptFile;
  readonly requestHash: string;
  readonly checkout: CheckoutFile;
}

function p256(key: KeyPair) {
  const jwk = key.publicJwk;
  return {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: jwk.x as string,
    y: jwk.y as string,
    alg: "ES256" as const,
    kid: key.kid,
  };
}

export async function generateSampleKeys(): Promise<SampleKeys> {
  const [issuer, agent, checkpoint] = await Promise.all([
    generateKey("ES256"),
    generateKey("ES256"),
    generateKey("Ed25519"),
  ]);
  return { issuer, agent, checkpoint };
}

export async function signedWorld(keys: SampleKeys): Promise<SampleWorld> {
  const nonce = "8Zq2_Xw1TbN4pLmR6vKc0A";
  const openJti = "01K3QF7XNZ8VMT4A9YB2CDEFGH";
  const closedJti = "01K3QF8ZZ0P6QW1E4RT7YABCDE";

  const openJws = await sign(
    {
      vct: OPEN_MANDATE_VCT,
      iss: "https://countersign.example/consent",
      sub: "usr_8f3ac21e",
      aud: AUDIENCE,
      jti: openJti,
      iat: 1_755_700_000,
      nbf: 1_755_700_000,
      exp: 1_755_786_400,
      cnf: { jwk: p256(keys.agent) },
      purpose: "q3_inventory_restock",
      policy_bundle_sha256: DIGEST,
      constraints: CONSTRAINTS,
    },
    keys.issuer,
    OPEN_MANDATE_TYP,
  );

  const requestHash = digestB64u(canonicalBytes(CHECKOUT));
  const closedJws = await sign(
    {
      vct: CLOSED_MANDATE_VCT,
      iss: "agent:pricing-bot",
      sub: "usr_8f3ac21e",
      aud: AUDIENCE,
      jti: closedJti,
      iat: 1_755_700_480,
      exp: 1_755_700_600,
      parent_hash: hashJws(openJws),
      request_hash: requestHash,
      nonce,
      amount: { amount: 1_499_000, currency: "INR" },
      payee: { id: "vnd_1042" },
      agent: {
        id: "agent:pricing-bot",
        version: "1.4.2",
        model: "claude-opus-5",
        runtime_sha256: DIGEST,
      },
      chain_depth: 2,
    },
    keys.agent,
    CLOSED_MANDATE_TYP,
  );

  const receipt = deriveReceipt(closedJti, requestHash);

  // The narrative comes from the engine, never from a hand-written string:
  // P1 replays decide() and binds rules, first_deny and reason, so a fixture
  // that authored its own explanation would fail its own verifier.
  const decision = decide(
    // Parsed through the same schema the verifier applies to the open
    // mandate, so bounds arrive as bigint minor units, exactly as replayed.
    CONSTRAINTS.map((c) => ConstraintSchema.parse(c)),
    { amount: money(1_499_000n, "INR"), payee: { id: "vnd_1042" }, rail: "razorpay_order" },
    { spent: money(0n, "INR"), actions: 0, recent: [] },
    NOW,
  );

  const draft: UnsealedRecord = {
    v: 1,
    seq: 0,
    ts: new Date(NOW * 1000).toISOString(),
    trace_id: "01K3QF8ZZ0ABCDEFGHJKMNPQRS",
    actor: {
      principal_id: "usr_8f3ac21e",
      agent_id: "agent:pricing-bot",
      agent_version: "1.4.2",
      model: "claude-opus-5",
      runtime_sha256: DIGEST,
    },
    mandate: {
      open_jti: openJti,
      open_hash: hashJws(openJws),
      closed_jti: closedJti,
      closed_hash: hashJws(closedJws),
      chain_depth: 2,
    },
    intent: { prompt_sha256: DIGEST, prompt_bytes: 80, redaction_profile: "pii-v2" },
    tool: {
      name: "razorpay.orders.create",
      args: { amount: 1_499_000, currency: "INR", receipt },
      args_sha256: digestB64u(canonicalBytes({ amount: 1_499_000, currency: "INR", receipt })),
    },
    policy: {
      bundle_sha256: DIGEST,
      engine_version: "0.3.1",
      rules_evaluated: decision.rules.map((r) => ({
        id: r.id,
        constraint: r.constraint,
        effect: r.effect,
      })),
      first_deny: decision.decidedBy,
    },
    accounting: {
      spent_before_paise: 0,
      amount_paise: 1_499_000,
      spent_after_paise: 1_499_000,
      actions_before: 0,
      actions_after: 1,
      budget_max_paise: 25_000_000,
      currency: "INR",
    },
    decision: "ALLOW",
    reason: decision.reason,
    external: {
      rail: "razorpay",
      idempotency_key: "idem-1",
      order_id: "order_MgXyZ1abc",
      payment_id: "pay_MgXyZ2def",
      signature_verified: true,
      status: "captured",
    },
    output_sha256: DIGEST,
    prev_hash: GENESIS_HASH,
  };

  const record = seal(draft);
  const entries = [utf8(record.record_hash)];
  const treeRoot = root(entries);
  const note = await signCheckpoint(
    { origin: ORIGIN, size: 1, rootHash: treeRoot },
    ORIGIN,
    keys.checkpoint,
  );

  const receiptFile: ReceiptFile = {
    receipt,
    closed_jti: closedJti,
    request_hash: requestHash,
    order_id: "order_MgXyZ1abc",
    payment_id: "pay_MgXyZ2def",
    amount_paise: 1_499_000,
    currency: "INR",
    seq: 0,
    record_hash: record.record_hash,
    tree_size: 1,
    leaf_hash: hex(leafHash(utf8(record.record_hash))),
    root: hex(treeRoot),
    proof: inclusionProof(0, entries).map(hex),
    checkpoint_note: note,
    record,
  };

  const checkout: CheckoutFile = {
    nonce,
    checkout: CHECKOUT,
    request: {
      amount_paise: 1_499_000,
      currency: "INR",
      payee: { id: "vnd_1042" },
      rail: "razorpay_order",
    },
  };

  return {
    keys,
    openJti,
    closedJti,
    openJws,
    closedJws,
    nonce,
    receipt,
    record,
    note,
    receiptFile,
    requestHash,
    checkout,
  };
}

export function writeTrustFile(dir: string, keys: SampleKeys, name = "trust.json"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        origin: ORIGIN,
        audience: AUDIENCE,
        checkpoint_key_name: ORIGIN,
        keys: {
          MANDATE_ISSUER_JWK: { alg: "ES256", kid: keys.issuer.kid, jwk: keys.issuer.publicJwk },
          CHECKPOINT_JWK: {
            alg: "Ed25519",
            kid: keys.checkpoint.kid,
            jwk: keys.checkpoint.publicJwk,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export function writeHonestBundle(dir: string, world: SampleWorld): void {
  writeBundle(dir, {
    records: [world.record],
    checkpoints: { 1: world.note },
    mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
    checkouts: { [world.closedJti]: world.checkout },
    receipts: { [world.receipt]: world.receiptFile },
    policy: { engine_version: "0.3.1", bundle_sha256: DIGEST },
  });
}

interface DecisionSpec {
  readonly label: "ALLOW" | "DENY" | "ESCALATE";
  readonly amountPaise: number;
  readonly constraints: readonly JsonValue[];
}

// One decision per open mandate — so per-mandate continuity (L6) is trivial and
// the bundle stays honest — chosen to exercise ALLOW, a DENY, and an ESCALATE.
const AMOUNT_RANGE = { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 };
const BUDGET = { type: "spend.budget", currency: "INR", max: 25_000_000 };
const PAYEES = { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] };
const RAIL = { type: "spend.rail", allowed: ["razorpay_order"] };

const DECISIONS: readonly DecisionSpec[] = [
  { label: "ALLOW", amountPaise: 1_499_000, constraints: [AMOUNT_RANGE, BUDGET, PAYEES, RAIL] },
  { label: "DENY", amountPaise: 6_000_000, constraints: [AMOUNT_RANGE, BUDGET, PAYEES, RAIL] },
  {
    label: "ESCALATE",
    amountPaise: 2_500_000,
    constraints: [
      AMOUNT_RANGE,
      BUDGET,
      PAYEES,
      RAIL,
      {
        type: "spend.escalation_threshold",
        currency: "INR",
        above: 2_000_000,
        requires: "human_approval",
      },
    ],
  },
];

interface BuiltRecord {
  readonly record: ReturnType<typeof seal>;
  readonly openJti: string;
  readonly openJws: string;
  readonly closedJti: string;
  readonly closedJws: string;
  readonly checkout: CheckoutFile;
  readonly receipt: string;
  readonly requestHash: string;
  readonly isAllow: boolean;
}

async function buildRecord(
  keys: SampleKeys,
  spec: DecisionSpec,
  seq: number,
  prevHash: string,
): Promise<BuiltRecord> {
  const openJti = ulid();
  const closedJti = ulid();
  const nonce = b64u(randomBytes(16));
  const checkoutObj: JsonValue = {
    cart_id: ulid(),
    currency: "INR",
    lines: [{ sku: `SKU-${seq}18`, qty: 1, unit_paise: spec.amountPaise }],
    total_paise: spec.amountPaise,
  };
  const requestHash = digestB64u(canonicalBytes(checkoutObj));

  const openJws = await sign(
    {
      vct: OPEN_MANDATE_VCT,
      iss: "https://countersign.example/consent",
      sub: "usr_8f3ac21e",
      aud: AUDIENCE,
      jti: openJti,
      iat: 1_755_700_000,
      nbf: 1_755_700_000,
      exp: 1_755_786_400,
      cnf: { jwk: p256(keys.agent) },
      purpose: "q3_inventory_restock",
      policy_bundle_sha256: DIGEST,
      constraints: spec.constraints as JsonValue,
    },
    keys.issuer,
    OPEN_MANDATE_TYP,
  );

  const closedJws = await sign(
    {
      vct: CLOSED_MANDATE_VCT,
      iss: "agent:pricing-bot",
      sub: "usr_8f3ac21e",
      aud: AUDIENCE,
      jti: closedJti,
      iat: 1_755_700_480,
      exp: 1_755_700_600,
      parent_hash: hashJws(openJws),
      request_hash: requestHash,
      nonce,
      amount: { amount: spec.amountPaise, currency: "INR" },
      payee: { id: "vnd_1042" },
      agent: {
        id: "agent:pricing-bot",
        version: "1.4.2",
        model: "claude-opus-5",
        runtime_sha256: DIGEST,
      },
      chain_depth: 2,
    },
    keys.agent,
    CLOSED_MANDATE_TYP,
  );

  const receipt = deriveReceipt(closedJti, requestHash);
  const decision = decide(
    spec.constraints.map((c) => ConstraintSchema.parse(c)),
    {
      amount: money(BigInt(spec.amountPaise), "INR"),
      payee: { id: "vnd_1042" },
      rail: "razorpay_order",
    },
    { spent: money(0n, "INR"), actions: 0, recent: [] },
    NOW,
  );

  const isAllow = spec.label === "ALLOW";
  const args = { amount: spec.amountPaise, currency: "INR", receipt };
  const draft: UnsealedRecord = {
    v: 1,
    seq,
    ts: new Date(NOW * 1000).toISOString(),
    trace_id: ulid(),
    actor: {
      principal_id: "usr_8f3ac21e",
      agent_id: "agent:pricing-bot",
      agent_version: "1.4.2",
      model: "claude-opus-5",
      runtime_sha256: DIGEST,
    },
    mandate: {
      open_jti: openJti,
      open_hash: hashJws(openJws),
      closed_jti: closedJti,
      closed_hash: hashJws(closedJws),
      chain_depth: 2,
    },
    intent: { prompt_sha256: DIGEST, prompt_bytes: 80, redaction_profile: "pii-v2" },
    tool: {
      name: "razorpay.orders.create",
      args,
      args_sha256: digestB64u(canonicalBytes(args)),
    },
    policy: {
      bundle_sha256: DIGEST,
      engine_version: "0.3.1",
      rules_evaluated: decision.rules.map((r) => ({
        id: r.id,
        constraint: r.constraint,
        effect: r.effect,
      })),
      first_deny: decision.decidedBy,
    },
    accounting: {
      spent_before_paise: 0,
      amount_paise: spec.amountPaise,
      // Reported even on a refusal: the counterfactual is what makes a DENY
      // record as useful as an ALLOW one.
      spent_after_paise: spec.amountPaise,
      actions_before: 0,
      actions_after: 1,
      budget_max_paise: 25_000_000,
      currency: "INR",
    },
    decision: spec.label,
    reason: decision.reason,
    external: isAllow
      ? {
          rail: "razorpay",
          idempotency_key: `idem-${seq}`,
          order_id: `order_Demo${seq}`,
          payment_id: `pay_Demo${seq}`,
          signature_verified: true,
          status: "captured",
        }
      : null,
    output_sha256: DIGEST,
    prev_hash: prevHash,
  };

  const checkout: CheckoutFile = {
    nonce,
    checkout: checkoutObj,
    request: {
      amount_paise: spec.amountPaise,
      currency: "INR",
      payee: { id: "vnd_1042" },
      rail: "razorpay_order",
    },
  };

  return {
    record: seal(draft),
    openJti,
    openJws,
    closedJti,
    closedJws,
    checkout,
    receipt,
    requestHash,
    isAllow,
  };
}

/**
 * Honest bundle + matching out-of-band trust. What `make demo` leaves for the
 * USB CLI. Three real decisions — a permit, a DENY and an ESCALATE, each under
 * its own mandate — so a judge who verifies the bundle watches P1 bind a
 * refusal's reason offline, not just an ALLOW's, and B2/B3 are not vacuous.
 */
export async function writeDemoExport(dir: string): Promise<{ bundle: string; trust: string }> {
  const keys = await generateSampleKeys();

  const built: BuiltRecord[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 0; seq < DECISIONS.length; seq += 1) {
    const one = await buildRecord(keys, DECISIONS[seq] as DecisionSpec, seq, prev);
    built.push(one);
    prev = one.record.record_hash;
  }

  const entries = built.map((b) => utf8(b.record.record_hash));
  const treeRoot = root(entries);
  const note = await signCheckpoint(
    { origin: ORIGIN, size: built.length, rootHash: treeRoot },
    ORIGIN,
    keys.checkpoint,
  );

  const mandates: Record<string, string> = {};
  const checkouts: Record<string, CheckoutFile> = {};
  const receipts: Record<string, ReceiptFile> = {};
  for (const b of built) {
    mandates[b.openJti] = b.openJws;
    mandates[b.closedJti] = b.closedJws;
    checkouts[b.closedJti] = b.checkout;
    // Only settled (ALLOW) records carry a Razorpay receipt file; a refusal
    // never reached the rail.
    if (b.isAllow) {
      const closed = b.checkout.checkout as { total_paise: number };
      receipts[b.receipt] = {
        receipt: b.receipt,
        closed_jti: b.closedJti,
        request_hash: b.requestHash,
        order_id: (b.record.external as { order_id: string }).order_id,
        payment_id: (b.record.external as { payment_id: string }).payment_id,
        amount_paise: closed.total_paise,
        currency: "INR",
        seq: b.record.seq,
        record_hash: b.record.record_hash,
        tree_size: built.length,
        leaf_hash: hex(leafHash(utf8(b.record.record_hash))),
        root: hex(treeRoot),
        proof: inclusionProof(b.record.seq, entries).map(hex),
        checkpoint_note: note,
        record: b.record,
      };
    }
  }

  const bundle = join(dir, "export");
  writeBundle(bundle, {
    records: built.map((b) => b.record),
    checkpoints: { [built.length]: note },
    mandates,
    checkouts,
    receipts,
    policy: { engine_version: "0.3.1", bundle_sha256: DIGEST },
  });

  // Named apart from the server's ./trust.json on purpose: the demo pair and
  // the server pair verify different bundles, and a near-identical filename
  // turned a wrong pairing into something that looked like tampering.
  return { bundle, trust: writeTrustFile(dir, keys, "trust.demo.json") };
}
