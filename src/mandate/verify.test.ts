import { beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "../crypto/canonical.js";
import { canonicalBytes } from "../crypto/canonical.js";
import { digestB64u, digestString } from "../crypto/digest.js";
import { sign } from "../crypto/jws.js";
import { generateKey, importPublicKey, type KeyPair, type PublicKeyRef } from "../crypto/keys.js";
import {
  CLOSED_MANDATE_TYP,
  CLOSED_MANDATE_VCT,
  OPEN_MANDATE_TYP,
  OPEN_MANDATE_VCT,
} from "./types.js";
import { hashJws, verifyChain } from "./verify.js";

const AUDIENCE = "https://countersign.example/agent-commerce";
const NONCE = "8Zq2_Xw1TbN4pLmR6vKc0A";
const NOW = 1_755_700_500;

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
let issuerPublic: PublicKeyRef;
let agent: KeyPair;
let attacker: KeyPair;

beforeAll(async () => {
  issuer = await generateKey("ES256");
  issuerPublic = await importPublicKey(issuer.publicJwk);
  agent = await generateKey("ES256");
  attacker = await generateKey("ES256");
});

type Json = Record<string, unknown>;

function openClaims(overrides: Json = {}, endorsed: KeyPair = agent): Json {
  return {
    vct: OPEN_MANDATE_VCT,
    iss: "https://countersign.example/consent",
    sub: "usr_8f3ac21e",
    aud: AUDIENCE,
    jti: "01K3QF7XNZ8VMT4A9YB2CDEFGH",
    iat: 1_755_700_000,
    nbf: 1_755_700_000,
    exp: 1_755_786_400,
    cnf: { jwk: endorsed.publicJwk },
    purpose: "q3_inventory_restock",
    policy_bundle_sha256: digestString("policy-bundle-v1"),
    constraints: CONSTRAINTS,
    ...overrides,
  };
}

function closedClaims(parentHash: string, overrides: Json = {}): Json {
  return {
    vct: CLOSED_MANDATE_VCT,
    iss: "agent:pricing-bot",
    sub: "usr_8f3ac21e",
    aud: AUDIENCE,
    // Crockford base32 omits I, L, O and U to keep ULIDs unambiguous when
    // read aloud or transcribed. PLAN.md §5's example violates that.
    jti: "01K3QF8ZZ0P6QW1E4RT7YABCDE",
    iat: 1_755_700_480,
    exp: 1_755_700_600,
    parent_hash: parentHash,
    request_hash: digestB64u(canonicalBytes(CHECKOUT)),
    nonce: NONCE,
    amount: { amount: 1_499_000, currency: "INR" },
    payee: { id: "vnd_1042" },
    agent: {
      id: "pricing-bot",
      version: "1.4.2",
      model: "claude-opus-5",
      runtime_sha256: digestString("runtime"),
    },
    chain_depth: 2,
    ...overrides,
  };
}

interface BuildOptions {
  readonly open?: Json;
  readonly closed?: Json;
  /** Who signs the open mandate. Defaults to the pinned issuer. */
  readonly openSigner?: KeyPair;
  /** Who signs the closed mandate. Defaults to the endorsed agent. */
  readonly closedSigner?: KeyPair;
  /** Whose key the open mandate endorses in `cnf`. */
  readonly endorsed?: KeyPair;
}

async function buildChain(opts: BuildOptions = {}) {
  const endorsed = opts.endorsed ?? agent;
  const openJws = await sign(
    openClaims(opts.open, endorsed) as JsonValue,
    opts.openSigner ?? issuer,
    OPEN_MANDATE_TYP,
  );

  const closedJws = await sign(
    closedClaims(hashJws(openJws), opts.closed) as JsonValue,
    opts.closedSigner ?? agent,
    CLOSED_MANDATE_TYP,
  );

  return { openJws, closedJws };
}

const run = (chain: { openJws: string; closedJws: string }, now = NOW) =>
  verifyChain(
    { ...chain, checkout: CHECKOUT, expectedNonce: NONCE, audience: AUDIENCE },
    { issuerKey: issuerPublic, now },
  );

describe("verifyChain: the happy path", () => {
  it("accepts a well-formed chain and returns the merged constraint set", async () => {
    const result = await run(await buildChain());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.open.sub).toBe("usr_8f3ac21e");
    expect(result.closed.amount).toEqual({ amount: 1_499_000n, currency: "INR" });
    expect(result.constraints).toHaveLength(CONSTRAINTS.length);
    expect(result.openHash).toHaveLength(43);
  });

  it("accepts a closed mandate that further attenuates", async () => {
    const chain = await buildChain({
      closed: {
        constraints: [
          { type: "spend.amount_range", currency: "INR", min: 0, max: 2_000_000 },
          { type: "spend.budget", currency: "INR", max: 25_000_000 },
          { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
          { type: "spend.rail", allowed: ["razorpay_order"] },
        ],
      },
    });

    const result = await run(chain);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The tighter of the two survives the merge.
    expect(result.constraints).toContainEqual(
      expect.objectContaining({ type: "spend.amount_range", max: 2_000_000n }),
    );
  });
});

describe("verifyChain: step 1 — the open mandate against a pinned key", () => {
  it("refuses a mandate signed by anyone but the pinned issuer", async () => {
    // The forged mandate is internally perfect. It fails only because the
    // verifying key is pinned and cannot be nominated by the token.
    const result = await run(await buildChain({ openSigner: attacker }));
    expect(result).toMatchObject({ ok: false, code: "open_signature_invalid", step: 1 });
  });

  it("refuses an expired open mandate", async () => {
    const result = await run(await buildChain(), 1_755_786_400 + 3_600);
    expect(result).toMatchObject({ ok: false, code: "expired", step: 1 });
  });

  it("refuses one that is not yet valid", async () => {
    const result = await run(await buildChain(), 1_755_690_000);
    expect(result).toMatchObject({ ok: false, code: "not_yet_valid", step: 1 });
  });

  it("refuses one addressed to a different merchant", async () => {
    const chain = await buildChain({
      open: { aud: "https://someone-else.example/agent-commerce" },
    });
    expect(await run(chain)).toMatchObject({ ok: false, code: "claims_disagree", step: 1 });
  });

  it("refuses a cnf JWK carrying private key material", async () => {
    const chain = await buildChain({
      open: { cnf: { jwk: { ...agent.publicJwk, d: "not-allowed-here" } } },
    });
    expect(await run(chain)).toMatchObject({ ok: false, code: "malformed", step: 1 });
  });
});

describe("verifyChain: step 2 — the closed mandate against the endorsed key", () => {
  it("refuses a closed mandate signed by a key the human never endorsed", async () => {
    // The agent self-asserting its own key is the whole attack. `cnf` says
    // one key; the signature is from another.
    const result = await run(await buildChain({ closedSigner: attacker }));
    expect(result).toMatchObject({ ok: false, code: "closed_signature_invalid", step: 2 });
  });

  it("refuses an open mandate presented where a closed one belongs", async () => {
    // Type confusion. A signature proves only that someone signed
    // something, so the media type has to be part of what is checked.
    const { openJws } = await buildChain();
    const result = await run({ openJws, closedJws: openJws });
    expect(result).toMatchObject({ ok: false, code: "closed_signature_invalid", step: 2 });
  });

  it("refuses a closed mandate that outlives its permitted window", async () => {
    const chain = await buildChain({
      closed: { iat: 1_755_700_480, exp: 1_755_700_480 + 3_600 },
    });
    expect(await run(chain)).toMatchObject({ ok: false, code: "malformed", step: 2 });
  });

  it("refuses an expired closed mandate under a still-valid open one", async () => {
    const result = await run(await buildChain(), 1_755_700_900);
    expect(result).toMatchObject({ ok: false, code: "expired", step: 2 });
  });
});

describe("verifyChain: step 3 — upward binding", () => {
  it("refuses a spliced parent", async () => {
    // A closed mandate minted under one open mandate, presented under a
    // different one issued to the SAME agent. Both signatures verify — the
    // agent key is endorsed by both — so step 2 passes and only the upward
    // binding catches the splice.
    const other = await buildChain({ open: { jti: "01K3QF7XNZ8VMT4A9YB2CDEFGJ" } });
    const chain = await buildChain();

    const result = await run({ openJws: other.openJws, closedJws: chain.closedJws });
    expect(result).toMatchObject({ ok: false, code: "parent_binding_invalid", step: 3 });
  });

  it("refuses a jti that is not a well-formed ULID", async () => {
    const chain = await buildChain({ closed: { jti: "01K3QF8ZZ0P6QW1E4RT7YUIOPA" } });
    expect(await run(chain)).toMatchObject({ ok: false, code: "malformed", step: 2 });
  });

  it("refuses a parent_hash that names something else", async () => {
    const chain = await buildChain({ closed: { parent_hash: digestString("some other mandate") } });
    expect(await run(chain)).toMatchObject({ ok: false, code: "parent_binding_invalid", step: 3 });
  });

  it("refuses a chain deeper than two", async () => {
    const chain = await buildChain({ closed: { chain_depth: 3 } });
    expect(await run(chain)).toMatchObject({ ok: false, code: "malformed", step: 2 });
  });
});

describe("verifyChain: step 4 — claims must agree", () => {
  it("refuses a swapped principal", async () => {
    // Billing a different human by editing the half the agent signs.
    const chain = await buildChain({ closed: { sub: "usr_someone_else" } });
    expect(await run(chain)).toMatchObject({ ok: false, code: "claims_disagree", step: 4 });
  });

  it("refuses a nonce this server did not issue", async () => {
    const chain = await buildChain({ closed: { nonce: "AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(await run(chain)).toMatchObject({ ok: false, code: "claims_disagree", step: 4 });
  });
});

describe("verifyChain: step 5 — attenuation", () => {
  const widened = (constraints: unknown) => buildChain({ closed: { constraints } });

  it("refuses a bigger per-transaction cap", async () => {
    const chain = await widened([
      { type: "spend.amount_range", currency: "INR", min: 0, max: 50_000_000 },
      { type: "spend.budget", currency: "INR", max: 25_000_000 },
      { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
      { type: "spend.rail", allowed: ["razorpay_order"] },
    ]);
    expect(await run(chain)).toMatchObject({ ok: false, code: "not_attenuated", step: 5 });
  });

  it("refuses a REMOVED cap", async () => {
    const chain = await widened([
      { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 },
      { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }] },
      { type: "spend.rail", allowed: ["razorpay_order"] },
    ]);
    const result = await run(chain);

    expect(result).toMatchObject({ ok: false, code: "not_attenuated", step: 5 });
    if (!result.ok) expect(result.reason).toMatch(/spend\.budget/);
  });

  it("refuses an extra payee", async () => {
    const chain = await widened([
      { type: "spend.amount_range", currency: "INR", min: 0, max: 5_000_000 },
      { type: "spend.budget", currency: "INR", max: 25_000_000 },
      { type: "spend.allowed_payees", allowed: [{ id: "vnd_1042" }, { id: "vnd_attacker" }] },
      { type: "spend.rail", allowed: ["razorpay_order"] },
    ]);
    expect(await run(chain)).toMatchObject({ ok: false, code: "not_attenuated", step: 5 });
  });

  it("refuses an EMPTY constraint array, which claims to be unconstrained", async () => {
    // The distinction the optional field exists for: omitting `constraints`
    // inherits the parent's set, but supplying `[]` is a claim to have none.
    expect(await run(await widened([]))).toMatchObject({ ok: false, code: "malformed", step: 2 });
  });

  it("refuses an unknown constraint type rather than skipping it", async () => {
    const chain = await widened([{ type: "spend.unlimited", max: 999 }]);
    expect(await run(chain)).toMatchObject({ ok: false, code: "malformed", step: 2 });
  });
});

describe("verifyChain: step 6 — the cart", () => {
  it("refuses a mandate bound to a different cart", async () => {
    const chain = await buildChain({
      closed: { request_hash: digestB64u(canonicalBytes({ total_paise: 1 })) },
    });
    expect(await run(chain)).toMatchObject({ ok: false, code: "request_binding_invalid", step: 6 });
  });

  it("recomputes the cart hash from our own checkout, never the agent's claim", async () => {
    // The agent signs a hash of a ₹14,990 cart; we price the order at ₹1.
    // Trusting the agent's `request_hash` would let a repriced cart through,
    // so the digest is computed here from the checkout we produced.
    const chain = await buildChain();
    const result = await verifyChain(
      {
        ...chain,
        checkout: { ...(CHECKOUT as Record<string, unknown>), total_paise: 1 } as JsonValue,
        expectedNonce: NONCE,
        audience: AUDIENCE,
      },
      { issuerKey: issuerPublic, now: NOW },
    );

    expect(result).toMatchObject({ ok: false, code: "request_binding_invalid", step: 6 });
  });
});

describe("verifyChain: ordering", () => {
  it("reports the EARLIEST failing step when a chain is wrong in several ways", async () => {
    // Order is a security property, not a cosmetic one. Each step decides
    // what the next may assume, so a later check must never run on a value
    // an earlier one has not authenticated.
    const chain = await buildChain({
      openSigner: attacker,
      closed: { sub: "usr_someone_else", request_hash: digestString("wrong cart") },
    });

    expect(await run(chain)).toMatchObject({ ok: false, step: 1 });
  });

  it("returns a value rather than throwing, so a refusal can be audited", async () => {
    const result = await run(await buildChain({ openSigner: attacker }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBeTruthy();
    expect(result.code).toBeTruthy();
  });
});
