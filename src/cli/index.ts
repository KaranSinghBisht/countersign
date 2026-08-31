/**
 * Countersign CLI.
 *
 *   countersign verify --bundle ./export --trust ./trust.json
 *   countersign verify-receipt --receipt ./r.json --trust ./trust.json
 *   countersign explain --bundle ./export --seq 4211
 *
 * Exit codes: 0 verified, 1 check failed, 2 malformed bundle, 3 trust error.
 * The verifier never reads a key out of the bundle.
 */

import { BundleError, loadBundle } from "../verify/bundle.js";
import { verifyBundle } from "../verify/checks.js";
import { type ExplainSelector, explain } from "../verify/explain.js";
import { verifyReceiptFile } from "../verify/receipt.js";
import {
  EXIT_FAILED,
  EXIT_MALFORMED,
  EXIT_OK,
  EXIT_TRUST,
  formatReport,
  reportToJson,
} from "../verify/report.js";
import { loadTrust, TrustError } from "../verify/trust.js";

function usage(): string {
  return `countersign — prove a merchant never spent outside a mandate

Usage:
  countersign verify          --bundle <dir|tar.gz> --trust <trust.json> [--json]
  countersign verify-receipt  --receipt <file>      --trust <trust.json> [--json]
  countersign explain         --bundle <dir|tar.gz> --seq <n>
                              (or --receipt <receipt> | --closed <jti> | --order <order_id>)

  --seq is the position every POST /purchase response returns as audit.seq.

Exit codes:
  0  verified
  1  a check failed
  2  the bundle is malformed
  3  the trust file is unusable

The keys come from --trust. A trust.json sitting inside the bundle is ignored.
`;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** Exactly one selector, or nothing — two selectors is a malformed request, not a merge. */
function explainSelector(args: readonly string[]): ExplainSelector | undefined {
  const seq = flag(args, "--seq");
  const receipt = flag(args, "--receipt");
  const closed = flag(args, "--closed");
  const order = flag(args, "--order");
  const given = [seq, receipt, closed, order].filter((v) => v !== undefined);
  if (given.length !== 1) return undefined;

  if (seq !== undefined) {
    const n = Number(seq);
    return Number.isInteger(n) && n >= 0 ? { seq: n } : undefined;
  }
  if (receipt !== undefined) return { receipt };
  if (closed !== undefined) return { closedJti: closed };
  return order === undefined ? undefined : { order };
}

function die(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    process.exit(EXIT_OK);
  }

  try {
    if (command === "verify") {
      const bundlePath = flag(rest, "--bundle");
      const trustPath = flag(rest, "--trust");
      if (bundlePath === undefined || trustPath === undefined) {
        die(EXIT_MALFORMED, "verify requires --bundle and --trust");
      }

      const trust = await loadTrust(trustPath);
      const bundle = loadBundle(bundlePath);
      const report = await verifyBundle(bundle, trust);

      if (json) process.stdout.write(`${JSON.stringify(reportToJson(report), null, 2)}\n`);
      else process.stdout.write(formatReport(report));

      process.exit(report.ok ? EXIT_OK : EXIT_FAILED);
    }

    if (command === "verify-receipt") {
      const receiptPath = flag(rest, "--receipt");
      const trustPath = flag(rest, "--trust");
      if (receiptPath === undefined || trustPath === undefined) {
        die(EXIT_MALFORMED, "verify-receipt requires --receipt and --trust");
      }

      const trust = await loadTrust(trustPath);
      const report = await verifyReceiptFile(receiptPath, trust);

      if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(report.ok ? "VERIFIED\n" : "FAILED\n");
        for (const finding of report.findings) {
          process.stdout.write(`  ${finding.ok ? "ok" : "FAIL"}  ${finding.detail}\n`);
        }
      }

      process.exit(report.ok ? EXIT_OK : EXIT_FAILED);
    }

    if (command === "explain") {
      const bundlePath = flag(rest, "--bundle");
      const selector = explainSelector(rest);
      if (bundlePath === undefined || selector === undefined) {
        die(
          EXIT_MALFORMED,
          "explain requires --bundle and exactly one of --seq, --receipt, --closed, --order",
        );
      }

      const bundle = loadBundle(bundlePath);
      const text = explain(bundle, selector);
      if (text === undefined) die(EXIT_FAILED, `no records match ${JSON.stringify(selector)}`);
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      process.exit(EXIT_OK);
    }

    die(EXIT_MALFORMED, `unknown command ${command}\n\n${usage()}`);
  } catch (error) {
    if (error instanceof TrustError) die(EXIT_TRUST, error.message);
    if (error instanceof BundleError) die(EXIT_MALFORMED, error.message);
    die(EXIT_MALFORMED, error instanceof Error ? error.message : String(error));
  }
}

await main(process.argv.slice(2));
