#!/usr/bin/env tsx
/**
 * Generate the three signing keys and print them as .env lines.
 *
 *     pnpm exec tsx scripts/gen-keys.ts          # print
 *     pnpm exec tsx scripts/gen-keys.ts --write  # patch .env in place
 *
 * Keys are emitted as base64url-encoded JWKs so they survive a single
 * environment variable without quoting problems.
 *
 * These land in a file on disk, unwrapped, with no HSM and no KMS. That is a
 * stated limitation rather than an oversight — whoever holds CHECKPOINT_JWK
 * can rebuild and re-sign the audit log, which is precisely why the verifier
 * takes its trusted keys from a pinned trust.json and never from the bundle
 * it is checking.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { b64u, utf8 } from "../src/crypto/encoding.js";
import { generateKey, type SigningAlgorithm } from "../src/crypto/keys.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface KeySpec {
  readonly variable: string;
  readonly alg: SigningAlgorithm;
  readonly purpose: string;
}

const KEYS: readonly KeySpec[] = [
  {
    variable: "MANDATE_ISSUER_JWK",
    alg: "ES256",
    purpose: "stands in for the human's consent surface; signs open mandates",
  },
  {
    variable: "AGENT_SIGNING_JWK",
    alg: "ES256",
    purpose: "the buying agent's key, endorsed by the open mandate's cnf claim",
  },
  {
    variable: "CHECKPOINT_JWK",
    alg: "Ed25519",
    purpose: "signs audit-log checkpoints; the root of the verifier's trust",
  },
];

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const lines: string[] = [];
  const trust: Record<string, unknown> = {
    $comment:
      "Public verification keys. Safe to publish. The verifier takes --trust pointing HERE, never a copy packed into an export bundle.",
    origin: "countersign.dev/audit",
    audience: "http://localhost:3000",
    checkpoint_key_name: "countersign.dev/audit",
    keys: {},
  };

  for (const { variable, alg, purpose } of KEYS) {
    const key = await generateKey(alg);
    lines.push(`${variable}=${b64u(utf8(JSON.stringify(key.privateJwk)))}`);
    (trust.keys as Record<string, unknown>)[variable] = {
      alg,
      kid: key.kid,
      jwk: key.publicJwk,
      purpose,
    };
  }

  // The public half, in the shape the verifier's --trust flag expects. A
  // verifier that learned its keys from the bundle under inspection would
  // prove nothing, so these have to be distributed out of band.
  const trustPath = join(ROOT, "trust.json");
  writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`, "utf8");

  if (!write) {
    console.log(lines.join("\n"));
    console.log(`\n# public keys written to ${trustPath}`);
    return;
  }

  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    console.error(`no .env found at ${envPath}. Run: cp .env.example .env`);
    process.exit(1);
  }

  let env = readFileSync(envPath, "utf8");
  for (const line of lines) {
    const [variable] = line.split("=") as [string];
    const pattern = new RegExp(`^${variable}=.*$`, "m");
    env = pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
  }
  writeFileSync(envPath, env, "utf8");

  console.log(`patched ${KEYS.length} keys into ${envPath}`);
  console.log(`public keys written to ${trustPath}`);
}

await main();
