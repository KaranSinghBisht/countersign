/**
 * Verifier output.
 *
 * Modelled on `rekor-cli` / `cosign verify`: a quiet success, and a failure
 * that names the exact seq and the exact delta. Exit codes are part of the
 * contract — scripts branch on them.
 *
 *   0  verified
 *   1  a check failed
 *   2  the bundle is malformed
 *   3  the trust file is unusable
 */

import type { CheckResult, Report } from "./checks.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_MALFORMED = 2;
export const EXIT_TRUST = 3;

export function formatReport(report: Report): string {
  const lines: string[] = [];

  if (report.ok) {
    lines.push(`VERIFIED  ${report.passed}/${report.total} checks`);
  } else {
    const unrun = report.skipped > 0 ? `, ${report.skipped} not evaluated` : "";
    lines.push(`FAILED    ${report.failed}/${report.total} checks failed${unrun}`);
  }

  let group = "";
  for (const check of report.checks) {
    if (check.spec.group !== group) {
      group = check.spec.group;
      lines.push("");
      lines.push(`  ${group}`);
    }
    lines.push(formatCheck(check));
  }

  const failures = report.checks.filter((c) => !c.ok && !c.skipped);
  if (failures.length > 0) {
    lines.push("");
    lines.push("failures:");
    for (const check of failures) {
      for (const finding of check.findings.filter((f) => !f.ok)) {
        const where = finding.seq === undefined ? "" : `  seq=${finding.seq}`;
        lines.push(`  ${check.spec.id}${where}  ${finding.detail}`);
      }
    }
  }

  const unrun = report.checks.filter((c) => c.skipped).map((c) => c.spec.id);
  if (unrun.length > 0) {
    lines.push("");
    lines.push(`not evaluated (an earlier check failed first): ${unrun.join(" ")}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatCheck(check: CheckResult): string {
  const mark = check.ok ? "ok" : check.skipped ? "--" : "FAIL";
  return `    ${check.spec.id.padEnd(4)} ${mark.padEnd(4)}  ${check.spec.name}`;
}

export function reportToJson(report: Report): unknown {
  return {
    ok: report.ok,
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    total: report.total,
    checks: report.checks.map((c) => ({
      id: c.spec.id,
      group: c.spec.group,
      name: c.spec.name,
      ok: c.ok,
      skipped: c.skipped,
      findings: c.findings,
    })),
  };
}
