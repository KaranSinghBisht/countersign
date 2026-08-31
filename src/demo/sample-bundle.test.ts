/**
 * The bundle `make demo` leaves for the USB CLI must pass all 30 checks AND
 * carry a real refusal — otherwise B2/B3 pass vacuously and a judge who
 * verifies it never watches P1 bind a DENY's reason offline.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "../verify/bundle.js";
import { verifyBundle } from "../verify/checks.js";
import { loadTrust } from "../verify/trust.js";
import { writeDemoExport } from "./sample-bundle.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "countersign-demo-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the demo export bundle", () => {
  it("verifies 30/30 against its out-of-band trust, with a DENY and an ESCALATE in it", async () => {
    const { bundle, trust } = await writeDemoExport(dir);

    const report = await verifyBundle(loadBundle(bundle), await loadTrust(trust));

    const failed = report.checks.filter((c) => !c.ok).map((c) => c.spec.id);
    expect(failed, `failed: ${failed.join(", ")}`).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(30);

    const decisions = loadBundle(bundle).records.map((r) => r.decision);
    expect(decisions).toContain("ALLOW");
    expect(decisions).toContain("DENY");
    expect(decisions).toContain("ESCALATE");
  });
});
