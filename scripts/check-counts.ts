/**
 * The test counts the landing page and the docs quote are hand-written, so
 * they drift — a reviewer who counted found the page understating. This pins
 * every quoted number to what vitest actually collects: add a test, and
 * `make check` fails until the copy follows.
 *
 *   pnpm exec tsx scripts/check-counts.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface Quote {
  readonly file: string;
  readonly pattern: RegExp;
  readonly expected: readonly number[];
}

function collected(project: "unit" | "integration"): number {
  const stdout = execFileSync("pnpm", ["exec", "vitest", "list", "--project", project, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const listed: unknown = JSON.parse(stdout);
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error(`vitest listed no ${project} tests`);
  }
  return listed.length;
}

function mismatches(quotes: readonly Quote[]): string[] {
  const problems: string[] = [];
  for (const quote of quotes) {
    const match = readFileSync(quote.file, "utf8").match(quote.pattern);
    if (match === null) {
      problems.push(`${quote.file}: no longer quotes a count matching ${quote.pattern}`);
      continue;
    }
    const quoted = match.slice(1).map(Number);
    if (quoted.join(",") !== quote.expected.join(",")) {
      problems.push(
        `${quote.file}: quotes ${quoted.join(" / ")}, the tree has ${quote.expected.join(" / ")}`,
      );
    }
  }
  return problems;
}

const unit = collected("unit");
const integration = collected("integration");

const problems = mismatches([
  {
    file: "src/http/pages/landing-body.ts",
    pattern: /<b>(\d+)<\/b> unit tests/,
    expected: [unit],
  },
  {
    file: "src/http/pages/landing-body.ts",
    pattern: /<b>(\d+)<\/b> integration tests/,
    expected: [integration],
  },
  {
    file: "src/http/pages/landing-body.ts",
    pattern: /(\d+) unit \+ (\d+) integration tests/,
    expected: [unit, integration],
  },
  { file: "docs/DEMO.md", pattern: /(\d+) unit tests/, expected: [unit] },
  { file: "AGENTS.md", pattern: /(\d+) unit tests/, expected: [unit] },
]);

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${unit} unit + ${integration} integration tests, as quoted\n`);
