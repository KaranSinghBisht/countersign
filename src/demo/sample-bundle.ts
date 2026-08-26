/**
 * A signed honest bundle, used by the tamper and omission rehearsals.
 *
 * Built the same way the verifier tests build one, so a judge who then runs
 * the unit tests is looking at the same bytes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sign as signCheckpoint } from "../audit/checkpoint.js";
import { inclusionProof, leafHash, root } from "../audit/merkle.js";
import { GENESIS_HASH, seal, type UnsealedRecord } from "../audit/record.js";
import type { JsonValue } from "../crypto/canonical.js";
import { canonicalBytes } from "../crypto/canonical.js";
import { digestB64u, digestString } from "../crypto/digest.js";
import { hex, utf8 } from "../crypto/encoding.js";
import { sign } from "../crypto/jws.js";
import { generateKey, type KeyPair } from "../crypto/keys.js";
import {
  CLOSED_MANDATE_TYP,
  CLOSED_MANDATE_VCT,
  OPEN_MANDATE_TYP,
  OPEN_MANDATE_VCT,
} from "../mandate/types.js";
import { hashJws } from "../mandate/verify.js";
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
      rules_evaluated: [{ id: "R-BUD-INR", constraint: "spend.budget", effect: "permit" }],
      first_deny: null,
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
    reason: "within per-transaction cap and aggregate budget",
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

export function writeTrustFile(dir: string, keys: SampleKeys): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "trust.json");
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

/** Honest bundle + matching out-of-band trust. What `make demo` leaves for the USB CLI. */
export async function writeDemoExport(root: string): Promise<{ bundle: string; trust: string }> {
  const keys = await generateSampleKeys();
  const world = await signedWorld(keys);
  const bundle = join(root, "export");
  writeHonestBundle(bundle, world);
  return { bundle, trust: writeTrustFile(root, keys) };
}
