import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sign as signCheckpoint } from "../audit/checkpoint.js";
import { inclusionProof, leafHash, root } from "../audit/merkle.js";
import { GENESIS_HASH, seal, type UnsealedRecord } from "../audit/record.js";
import type { JsonValue } from "../crypto/canonical.js";
import { canonicalBytes } from "../crypto/canonical.js";
import { digestB64u, digestString } from "../crypto/digest.js";
import { hex, utf8 } from "../crypto/encoding.js";
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
import { loadBundle } from "./bundle.js";
import { CHECKS, verifyBundle } from "./checks.js";
import { explainOrder } from "./explain.js";
import { writeBundle } from "./export.js";
import { verifyReceiptFile } from "./receipt.js";
import { formatReport } from "./report.js";
import { loadTrust, type Trust } from "./trust.js";

const ORIGIN = "countersign.dev/audit";
const AUDIENCE = "https://countersign.example/agent-commerce";
const NOW = 1_755_700_500;
const DIGEST = digestString("fixture");
const CHECKOUT: JsonValue = {
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

let issuer: KeyPair;
let agent: KeyPair;
let checkpoint: KeyPair;
let attacker: KeyPair;
const temps: string[] = [];

beforeAll(async () => {
  issuer = await generateKey("ES256");
  agent = await generateKey("ES256");
  checkpoint = await generateKey("Ed25519");
  attacker = await generateKey("Ed25519");
});

afterEach(() => {
  // Directories under tmpdir are leftover on purpose; tests must not depend
  // on being able to delete them, and the OS reaps them.
  temps.length = 0;
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `countersign-${prefix}-`));
  temps.push(dir);
  return dir;
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

async function signedWorld(opts?: {
  decision?: "ALLOW" | "DENY" | "ESCALATE";
  firstDeny?: string | null;
}) {
  const decision = opts?.decision ?? "ALLOW";
  const firstDeny =
    opts?.firstDeny !== undefined ? opts.firstDeny : decision === "ALLOW" ? null : "R-BUD-INR";
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
      cnf: { jwk: p256(agent) },
      purpose: "q3_inventory_restock",
      policy_bundle_sha256: DIGEST,
      constraints: CONSTRAINTS,
    },
    issuer,
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
    agent,
    CLOSED_MANDATE_TYP,
  );

  const receipt = deriveReceipt(closedJti, requestHash);

  // The honest ALLOW carries the engine's own narrative (P1 binds rules,
  // first_deny and reason to a replay); the DENY / ESCALATE variants keep
  // hand-authored values because they exist to be caught.
  const replay = decide(
    CONSTRAINTS.map((c) => ConstraintSchema.parse(c)),
    { amount: money(1_499_000n, "INR"), payee: { id: "vnd_1042" }, rail: "razorpay_order" },
    { spent: money(0n, "INR"), actions: 0, recent: [] },
    NOW,
  );
  const honest = decision === "ALLOW";

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
      rules_evaluated: honest
        ? replay.rules.map((r) => ({ id: r.id, constraint: r.constraint, effect: r.effect }))
        : [{ id: "R-BUD-INR", constraint: "spend.budget", effect: "permit" }],
      first_deny: honest ? replay.decidedBy : firstDeny,
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
    decision,
    reason: honest ? replay.reason : "within per-transaction cap and aggregate budget",
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
    checkpoint,
  );

  const receiptFile = {
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

  return {
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
  };
}

function honestCheckout(world: Awaited<ReturnType<typeof signedWorld>>, payee = "vnd_1042") {
  return {
    [world.closedJti]: {
      nonce: world.nonce,
      checkout: CHECKOUT,
      request: {
        amount_paise: 1_499_000,
        currency: "INR",
        payee: { id: payee },
        rail: "razorpay_order",
      },
    },
  };
}

function writeHonest(
  dir: string,
  world: Awaited<ReturnType<typeof signedWorld>>,
  payee = "vnd_1042",
) {
  writeBundle(dir, {
    records: [world.record],
    checkpoints: { 1: world.note },
    mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
    checkouts: honestCheckout(world, payee),
    receipts: { [world.receipt]: world.receiptFile },
    policy: { engine_version: "0.3.1", bundle_sha256: DIGEST },
  });
}

function writeTrust(dir: string, checkpointKey: KeyPair = checkpoint): string {
  const path = join(dir, "trust.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        origin: ORIGIN,
        audience: AUDIENCE,
        checkpoint_key_name: ORIGIN,
        keys: {
          MANDATE_ISSUER_JWK: { alg: "ES256", kid: issuer.kid, jwk: issuer.publicJwk },
          CHECKPOINT_JWK: { alg: "Ed25519", kid: checkpointKey.kid, jwk: checkpointKey.publicJwk },
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function loadPinned(path: string): Promise<Trust> {
  return loadTrust(path);
}

describe("the check list", () => {
  it("is exactly thirty, across the seven groups", () => {
    expect(CHECKS).toHaveLength(30);
    expect(new Set(CHECKS.map((c) => c.group)).size).toBe(7);
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(30);
  });
});

describe("an honest bundle", () => {
  it("verifies all thirty checks", async () => {
    const world = await signedWorld();
    const dir = tmp("honest");

    writeBundle(dir, {
      records: [world.record],
      checkpoints: { 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: {
        [world.closedJti]: {
          nonce: world.nonce,
          checkout: CHECKOUT,
          request: {
            amount_paise: 1_499_000,
            currency: "INR",
            payee: { id: "vnd_1042" },
            rail: "razorpay_order",
          },
        },
      },
      receipts: { [world.receipt]: world.receiptFile },
      policy: { engine_version: "0.3.1", bundle_sha256: DIGEST },
    });

    // A trust.json inside the bundle must not be consulted.
    writeTrust(dir, attacker);

    const trustPath = writeTrust(tmp("trust"));
    const report = await verifyBundle(loadBundle(dir), await loadPinned(trustPath));

    expect(report.ok, formatReport(report)).toBe(true);
    expect(report.passed).toBe(30);
    expect(report.failed).toBe(0);
  });

  it("fails P1 when decide() would deny the recorded ALLOW", async () => {
    const world = await signedWorld();
    const dir = tmp("p1");
    writeHonest(dir, world, "vnd_attacker");

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "P1")?.ok).toBe(false);
  });

  it("fails B2 on a DENY record that omitted first_deny", async () => {
    const world = await signedWorld({ decision: "DENY", firstDeny: null });
    const dir = tmp("b2");
    writeHonest(dir, world);

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "B2")?.ok).toBe(false);
  });

  it("fails L9 when the bundled receipt proof is not the tree's", async () => {
    const world = await signedWorld();
    const dir = tmp("l9");
    writeBundle(dir, {
      records: [world.record],
      checkpoints: { 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: honestCheckout(world),
      receipts: {
        [world.receipt]: {
          ...world.receiptFile,
          proof: ["00".repeat(32)],
        },
      },
      policy: { engine_version: "0.3.1", bundle_sha256: DIGEST },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "L9")?.ok).toBe(false);
  });

  it("fails L2 when args_sha256 does not match args after resealing", async () => {
    const world = await signedWorld();
    const tampered = seal({
      ...world.record,
      tool: {
        ...world.record.tool,
        args: { amount: 1, currency: "INR", receipt: world.receipt },
      },
    });
    const entries = [utf8(tampered.record_hash)];
    const note = await signCheckpoint(
      { origin: ORIGIN, size: 1, rootHash: root(entries) },
      ORIGIN,
      checkpoint,
    );
    const dir = tmp("args");
    writeBundle(dir, {
      records: [tampered],
      checkpoints: { 1: note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: honestCheckout(world),
      receipts: {
        [world.receipt]: {
          ...world.receiptFile,
          seq: 0,
          record_hash: tampered.record_hash,
          tree_size: 1,
          leaf_hash: hex(leafHash(utf8(tampered.record_hash))),
          root: hex(root(entries)),
          proof: inclusionProof(0, entries).map(hex),
          checkpoint_note: note,
          record: tampered,
        },
      },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    const l2 = report.checks.find((c) => c.spec.id === "L2");
    expect(l2?.ok).toBe(false);
    expect(l2?.findings.some((f) => f.detail.includes("args_sha256"))).toBe(true);
  });

  it("fails T2 when a closed jti is reused even if the later record is DENY", async () => {
    const world = await signedWorld({ decision: "DENY", firstDeny: "R-BUD-INR" });
    const second = seal({
      ...world.record,
      seq: 1,
      prev_hash: world.record.record_hash,
      decision: "DENY",
      policy: { ...world.record.policy, first_deny: "R-BUD-INR" },
      accounting: {
        ...world.record.accounting,
        spent_before_paise: 0,
        spent_after_paise: 1_499_000,
        actions_before: 0,
        actions_after: 1,
      },
    });
    const entries = [utf8(world.record.record_hash), utf8(second.record_hash)];
    const note = await signCheckpoint(
      { origin: ORIGIN, size: 2, rootHash: root(entries) },
      ORIGIN,
      checkpoint,
    );
    const receipt2 = {
      ...world.receiptFile,
      seq: 1,
      record_hash: second.record_hash,
      tree_size: 2,
      leaf_hash: hex(leafHash(utf8(second.record_hash))),
      root: hex(root(entries)),
      proof: inclusionProof(1, entries).map(hex),
      checkpoint_note: note,
      record: second,
    };
    const receipt1 = {
      ...world.receiptFile,
      tree_size: 2,
      root: hex(root(entries)),
      proof: inclusionProof(0, entries).map(hex),
      checkpoint_note: note,
    };
    const dir = tmp("t2");
    writeBundle(dir, {
      records: [world.record, second],
      checkpoints: { 2: note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: honestCheckout(world),
      receipts: {
        [world.receipt]: receipt1,
        [`${world.receipt}2`]: receipt2,
      },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "T2")?.ok).toBe(false);
  });

  it("checks every historical checkpoint root against the log prefix", async () => {
    const world = await signedWorld();
    const genesis = await signCheckpoint(
      { origin: ORIGIN, size: 0, rootHash: new Uint8Array(32).fill(1) },
      ORIGIN,
      checkpoint,
    );
    const dir = tmp("hist");
    writeBundle(dir, {
      records: [world.record],
      checkpoints: { 0: genesis, 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: honestCheckout(world),
      receipts: { [world.receipt]: world.receiptFile },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "L8")?.ok).toBe(false);
  });
});

describe("tamper", () => {
  it("naive: editing an amount fails the record hash at that seq", async () => {
    const world = await signedWorld();
    const dir = tmp("naive");
    const edited = {
      ...world.record,
      accounting: { ...world.record.accounting, amount_paise: 1, spent_after_paise: 1 },
    };

    writeBundle(dir, {
      records: [edited],
      checkpoints: { 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: {
        [world.closedJti]: {
          nonce: world.nonce,
          checkout: CHECKOUT,
          request: {
            amount_paise: 1_499_000,
            currency: "INR",
            payee: { id: "vnd_1042" },
            rail: "razorpay_order",
          },
        },
      },
      receipts: { [world.receipt]: world.receiptFile },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);

    const l2 = report.checks.find((c) => c.spec.id === "L2");
    expect(l2?.ok).toBe(false);
    expect(l2?.findings[0]?.seq).toBe(0);
    expect(l2?.findings[0]?.detail).toContain("record_hash");
  });

  it("sophisticated: relinking the chain still fails the checkpoint", async () => {
    // The AWS-sample failure mode: recompute hashes so the chain is internally
    // consistent. The checkpoint was signed over the original root, and the
    // verifier's key is pinned, so this still fails.
    const world = await signedWorld();
    const dir = tmp("soph");

    const tampered = seal({
      ...world.record,
      accounting: { ...world.record.accounting, amount_paise: 42, spent_after_paise: 42 },
    });

    writeBundle(dir, {
      records: [tampered],
      checkpoints: { 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: {
        [world.closedJti]: {
          nonce: world.nonce,
          checkout: CHECKOUT,
          request: {
            amount_paise: 1_499_000,
            currency: "INR",
            payee: { id: "vnd_1042" },
            rail: "razorpay_order",
          },
        },
      },
      receipts: { [world.receipt]: world.receiptFile },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);

    const l2 = report.checks.find((c) => c.spec.id === "L2");
    expect(l2?.ok).toBe(true);

    const l8 = report.checks.find((c) => c.spec.id === "L8");
    expect(l8?.ok).toBe(false);
    expect(l8?.findings[0]?.detail).toMatch(/Merkle root|checkpoint/i);

    const l10 = report.checks.find((c) => c.spec.id === "L10");
    expect(l10?.ok).toBe(true);
  });

  it("omission: a dropped record is visible in the running total", async () => {
    const world = await signedWorld();
    const second = seal({
      ...world.record,
      seq: 1,
      prev_hash: world.record.record_hash,
      mandate: { ...world.record.mandate, closed_jti: "01K3QF8ZZ0P6QW1E4RT7YABCDF" },
      accounting: {
        ...world.record.accounting,
        spent_before_paise: 1_499_000,
        spent_after_paise: 2_998_000,
        actions_before: 1,
        actions_after: 2,
      },
    });
    const third = seal({
      ...world.record,
      seq: 2,
      prev_hash: second.record_hash,
      mandate: { ...world.record.mandate, closed_jti: "01K3QF8ZZ0P6QW1E4RT7YABCDG" },
      accounting: {
        ...world.record.accounting,
        spent_before_paise: 2_998_000,
        spent_after_paise: 4_497_000,
        actions_before: 2,
        actions_after: 3,
      },
    });

    const kept = [world.record, third];
    const prev = world.record.record_hash;
    const relinked = [world.record, seal({ ...third, seq: 1, prev_hash: prev })];
    void kept;
    void prev;

    const dir = tmp("omit");
    const entries = relinked.map((r) => utf8(r.record_hash));
    const note = await signCheckpoint(
      { origin: ORIGIN, size: 2, rootHash: root(entries) },
      ORIGIN,
      checkpoint,
    );

    writeBundle(dir, {
      records: relinked,
      checkpoints: { 2: note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: {
        [world.closedJti]: {
          nonce: world.nonce,
          checkout: CHECKOUT,
          request: {
            amount_paise: 1_499_000,
            currency: "INR",
            payee: { id: "vnd_1042" },
            rail: "razorpay_order",
          },
        },
      },
      receipts: { [world.receipt]: world.receiptFile },
    });

    const report = await verifyBundle(loadBundle(dir), await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);

    const l6 = report.checks.find((c) => c.spec.id === "L6");
    expect(l6?.ok).toBe(false);
    expect(l6?.findings[0]?.seq).toBe(1);
    expect(l6?.findings[0]?.detail).toContain("unaccounted");
  });
});

describe("trust is out of band", () => {
  it("refuses a checkpoint signed by a key that is not pinned", async () => {
    const world = await signedWorld();
    const dir = tmp("fork");
    writeBundle(dir, {
      records: [world.record],
      checkpoints: { 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: {
        [world.closedJti]: {
          nonce: world.nonce,
          checkout: CHECKOUT,
          request: {
            amount_paise: 1_499_000,
            currency: "INR",
            payee: { id: "vnd_1042" },
            rail: "razorpay_order",
          },
        },
      },
      receipts: { [world.receipt]: world.receiptFile },
    });

    const report = await verifyBundle(
      loadBundle(dir),
      await loadPinned(writeTrust(tmp("atk"), attacker)),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "L10")?.ok).toBe(false);
  });

  it("does not learn keys from a trust.json sitting in the bundle", async () => {
    const world = await signedWorld();
    const dir = tmp("union");
    writeHonest(dir, world);
    writeTrust(dir);

    const report = await verifyBundle(
      loadBundle(dir),
      await loadPinned(writeTrust(tmp("atk"), attacker)),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.spec.id === "L10")?.ok).toBe(false);
  });

  it("rejects a trust file that smuggles a private key", async () => {
    const dir = tmp("priv");
    const path = join(dir, "trust.json");
    writeFileSync(
      path,
      `${JSON.stringify({
        origin: ORIGIN,
        audience: AUDIENCE,
        keys: {
          MANDATE_ISSUER_JWK: { alg: "ES256", jwk: issuer.privateJwk },
          CHECKPOINT_JWK: { alg: "Ed25519", jwk: checkpoint.publicJwk },
        },
      })}\n`,
    );

    await expect(loadTrust(path)).rejects.toThrow(/PUBLIC keys only|private key/i);
  });
});

describe("verify-receipt", () => {
  it("verifies a receipt without the log", async () => {
    const world = await signedWorld();
    const dir = tmp("receipt");
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(world.receiptFile, null, 2)}\n`);

    const report = await verifyReceiptFile(receiptPath, await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(true);
  });

  it("rejects a receipt whose inclusion proof was rewritten", async () => {
    const world = await signedWorld();
    const dir = tmp("bad-receipt");
    const forged = { ...world.receiptFile, proof: [hex(utf8("nope"))] };
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(forged)}\n`);

    const report = await verifyReceiptFile(receiptPath, await loadPinned(writeTrust(tmp("t"))));
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.detail.includes("inclusion"))).toBe(true);
  });

  it("rejects a receipt whose displayed amount was rewritten", async () => {
    const world = await signedWorld();
    const dir = tmp("amount");
    const forged = { ...world.receiptFile, amount_paise: 1 };
    writeFileSync(join(dir, "receipt.json"), `${JSON.stringify(forged)}\n`);

    const report = await verifyReceiptFile(
      join(dir, "receipt.json"),
      await loadPinned(writeTrust(tmp("t"))),
    );
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.detail.includes("amount_paise"))).toBe(true);
  });
});

describe("explain", () => {
  it("narrates every record for an order", async () => {
    const world = await signedWorld();
    const dir = tmp("explain");
    writeBundle(dir, {
      records: [world.record],
      checkpoints: { 1: world.note },
      mandates: { [world.openJti]: world.openJws, [world.closedJti]: world.closedJws },
      checkouts: {},
      receipts: {},
    });

    const text = explainOrder(loadBundle(dir), "order_MgXyZ1abc");
    expect(text).toContain("ALLOW");
    expect(text).toContain("seq 0");
    expect(text).toContain("order_MgXyZ1abc");
  });
});

describe("malformed bundles", () => {
  it("rejects a MANIFEST that does not match the files", async () => {
    const world = await signedWorld();
    const dir = tmp("manifest");
    writeBundle(dir, {
      records: [world.record],
      checkpoints: { 1: world.note },
      mandates: {},
      checkouts: {},
      receipts: {},
    });
    writeFileSync(
      join(dir, "records.jsonl"),
      `${readFileSync(join(dir, "records.jsonl"), "utf8")} \n`,
    );

    expect(() => loadBundle(dir)).toThrow(/digest mismatch/);
  });
});
