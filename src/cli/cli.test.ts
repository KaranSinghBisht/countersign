/**
 * The USB path. `make check` never built `dist/countersign.mjs`, so these
 * spawn the same entry the esbuild bundle wraps.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateSampleKeys,
  signedWorld,
  writeHonestBundle,
  writeTrustFile,
} from "../demo/sample-bundle.js";
import { EXIT_FAILED, EXIT_MALFORMED, EXIT_OK, EXIT_TRUST } from "../verify/report.js";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("./index.ts", import.meta.url));

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `countersign-cli-${prefix}-`));
}

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("countersign CLI", () => {
  it("does not put a shebang in the source — esbuild stamps one", () => {
    const source = readFileSync(cli, "utf8");
    expect(source.startsWith("#!")).toBe(false);
    const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");
    expect(makefile).toMatch(/--banner:js="#!\/usr\/bin\/env node"/);
  });

  it("verifies an honest bundle against out-of-band trust and exits 0", async () => {
    const keys = await generateSampleKeys();
    const world = await signedWorld(keys);
    const bundle = tmp("honest");
    writeHonestBundle(bundle, world);
    const trust = writeTrustFile(tmp("trust"), keys);

    const result = run(["verify", "--bundle", bundle, "--trust", trust]);
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/VERIFIED/);
  });

  it("uses --trust, not a trust.json packed inside the bundle", async () => {
    const honest = await generateSampleKeys();
    const attacker = await generateSampleKeys();
    const world = await signedWorld(honest);
    const bundle = tmp("packed");
    writeHonestBundle(bundle, world);
    writeTrustFile(bundle, honest);

    const result = run([
      "verify",
      "--bundle",
      bundle,
      "--trust",
      writeTrustFile(tmp("atk"), attacker),
    ]);
    expect(result.status).toBe(EXIT_FAILED);
    expect(result.stdout).toMatch(/L10/);
  });

  it("exits 2 when --trust is omitted", async () => {
    const keys = await generateSampleKeys();
    const world = await signedWorld(keys);
    const bundle = tmp("notrust");
    writeHonestBundle(bundle, world);

    const result = run(["verify", "--bundle", bundle]);
    expect(result.status).toBe(EXIT_MALFORMED);
    expect(result.stderr).toMatch(/--trust/);
  });

  it("exits 3 on an unusable trust file", () => {
    const path = join(tmp("bad"), "trust.json");
    writeFileSync(path, "{}\n");

    const result = run(["verify", "--bundle", tmp("empty"), "--trust", path]);
    expect(result.status).toBe(EXIT_TRUST);
  });
});
