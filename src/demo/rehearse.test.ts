import { describe, expect, it } from "vitest";
import {
  budgetExceeded,
  escalation,
  formatRehearsal,
  omission,
  promptInjection,
  runRehearsal,
  tamperNaive,
  tamperSophisticated,
} from "./rehearse.js";

describe("rehearsed failures", () => {
  it("denies over budget with the rule id and the counterfactual total", () => {
    const result = budgetExceeded();
    expect(result.rehearsed).toBe(true);
    expect(result.verdict).toBe("DENY R-BUD-INR");
    expect(result.lines.join("\n")).toMatch(/2,54,990\.00|254,990\.00/);
    expect(result.lines.join("\n")).toMatch(/2,50,000\.00|250,000\.00/);
  });

  it("escalates rather than denying above the threshold", () => {
    const result = escalation();
    expect(result.rehearsed).toBe(true);
    expect(result.verdict).toBe("ESCALATE R-ESC-INR");
    expect(result.lines.join("\n")).toMatch(/unresolved_constraint/);
  });

  it("fails a naive amount edit on L2 at seq 0", async () => {
    const result = await tamperNaive();
    expect(result.rehearsed).toBe(true);
    expect(result.verdict).toMatch(/L2 seq=0/);
  });

  it("fails a resealed chain on the pinned checkpoint, not the hashes", async () => {
    const result = await tamperSophisticated();
    expect(result.rehearsed).toBe(true);
    expect(result.verdict).toMatch(/L8/);
  });

  it("fails an omitted middle record on the running total", async () => {
    const result = await omission();
    expect(result.rehearsed).toBe(true);
    expect(result.verdict).toMatch(/L6/);
    expect(result.lines.join("\n")).toMatch(/unaccounted/);
  });

  it("rejects the 90% off injection at the gate, not in decide()", () => {
    const result = promptInjection();
    expect(result.rehearsed).toBe(true);
    expect(result.lines.join("\n")).toMatch(/ignore previous instructions/);
    expect(result.lines.join("\n")).toMatch(/decide\(\) permit/);
  });

  it("runs the offline six in well under 20 seconds", async () => {
    const run = await runRehearsal();
    const offline = run.scenarios.filter((s) => s.id !== "webhook" && s.id !== "duplicate");
    expect(offline.every((s) => s.rehearsed)).toBe(true);
    expect(run.elapsedMs).toBeLessThan(20_000);
    expect(formatRehearsal(run)).toMatch(/rehearsed/);
  });
});
