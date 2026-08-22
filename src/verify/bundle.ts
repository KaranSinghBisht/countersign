/**
 * An audit bundle: the files a third party needs to check us, and nothing else.
 *
 * Layout:
 *
 *   MANIFEST.json
 *   records.jsonl
 *   checkpoints/<size>.note
 *   mandates/<jti>.jws
 *   checkouts/<closed_jti>.json
 *   receipts/<receipt>.json
 *   policy/engine.json
 *
 * A `trust.json` inside the bundle is not read. The keys come from `--trust`,
 * which is a different file the operator already has.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type AuditRecord, AuditRecordSchema } from "../audit/record.js";
import { digestB64u } from "../crypto/digest.js";
import { utf8 } from "../crypto/encoding.js";

export class BundleError extends Error {
  override readonly name = "BundleError";
}

export const ManifestSchema = z
  .object({
    v: z.literal(1),
    created_at: z.string().min(1),
    files: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)),
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

export const CheckoutSchema = z
  .object({
    nonce: z.string().min(16),
    checkout: z.unknown(),
    request: z.object({
      amount_paise: z.number().int().positive(),
      currency: z.string().length(3),
      payee: z.object({ id: z.string().min(1) }),
      rail: z.string().min(1),
    }),
  })
  .strict();

export type CheckoutFile = z.infer<typeof CheckoutSchema>;

export const ReceiptSchema = z
  .object({
    receipt: z.string().min(1),
    closed_jti: z.string().min(1),
    request_hash: z.string().min(1),
    order_id: z.string().nullable(),
    payment_id: z.string().nullable(),
    amount_paise: z.number().int().nonnegative(),
    currency: z.string().length(3),
    seq: z.number().int().nonnegative(),
    record_hash: z.string().min(1),
    tree_size: z.number().int().nonnegative(),
    leaf_hash: z.string().min(1),
    root: z.string().min(1),
    proof: z.array(z.string()),
    checkpoint_note: z.string().min(1),
  })
  .strict();

export type ReceiptFile = z.infer<typeof ReceiptSchema>;

export const PolicyFileSchema = z
  .object({
    engine_version: z.string().min(1),
    bundle_sha256: z.string().min(1),
  })
  .strict();

export interface LoadedBundle {
  readonly root: string;
  readonly manifest: Manifest;
  readonly records: AuditRecord[];
  readonly checkpoints: ReadonlyMap<number, string>;
  readonly mandates: ReadonlyMap<string, string>;
  readonly checkouts: ReadonlyMap<string, CheckoutFile>;
  readonly receipts: ReadonlyMap<string, ReceiptFile>;
  readonly policy: z.infer<typeof PolicyFileSchema> | undefined;
}

export function loadBundle(path: string): LoadedBundle {
  const root = expand(path);
  const manifest = readManifest(root);
  assertManifest(root, manifest);

  return {
    root,
    manifest,
    records: readRecords(root),
    checkpoints: readNotes(join(root, "checkpoints")),
    mandates: readTextDir(join(root, "mandates"), ".jws"),
    checkouts: readJsonDir(join(root, "checkouts"), CheckoutSchema),
    receipts: readJsonDir(join(root, "receipts"), ReceiptSchema),
    policy: optionalJson(join(root, "policy", "engine.json"), PolicyFileSchema),
  };
}

function expand(path: string): string {
  if (!statExists(path)) throw new BundleError(`bundle not found: ${path}`);

  if (statSync(path).isDirectory()) return path;

  if (!/\.(tar\.gz|tgz)$/.test(path)) {
    throw new BundleError(`bundle must be a directory or a .tar.gz, got ${path}`);
  }

  const dest = mkdtempSync(join(tmpdir(), "countersign-bundle-"));
  try {
    execFileSync("tar", ["-xzf", path, "-C", dest], { stdio: "pipe" });
  } catch (error) {
    throw new BundleError(`failed to unpack ${path}: ${(error as Error).message}`);
  }

  const entries = readdirSync(dest);
  if (entries.length === 1) {
    const nested = join(dest, entries[0] as string);
    if (statExists(nested) && statSync(nested).isDirectory()) return nested;
  }
  return dest;
}

function readManifest(root: string): Manifest {
  const raw = readFile(join(root, "MANIFEST.json"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BundleError("MANIFEST.json is not JSON");
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new BundleError(
      `MANIFEST.json is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

function assertManifest(root: string, manifest: Manifest): void {
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const bytes = readBytes(join(root, relative));
    const actual = digestB64u(bytes);
    if (actual !== expected) {
      throw new BundleError(
        `MANIFEST.json digest mismatch for ${relative}: declared ${expected}, file is ${actual}`,
      );
    }
  }
}

function readRecords(root: string): AuditRecord[] {
  const raw = readFile(join(root, "records.jsonl"));
  const records: AuditRecord[] = [];

  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new BundleError(`records.jsonl line ${index + 1} is not JSON`);
    }
    const result = AuditRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new BundleError(
        `records.jsonl line ${index + 1} failed schema: ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    records.push(result.data);
  }

  return records;
}

function readNotes(dir: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!statExists(dir) || !statSync(dir).isDirectory()) return out;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".note")) continue;
    const size = Number(name.slice(0, -".note".length));
    if (!Number.isInteger(size) || size < 0) {
      throw new BundleError(`checkpoint filename ${name} is not <tree_size>.note`);
    }
    out.set(size, readFile(join(dir, name)));
  }
  return out;
}

function readTextDir(dir: string, suffix: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!statExists(dir) || !statSync(dir).isDirectory()) return out;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    out.set(name.slice(0, -suffix.length), readFile(join(dir, name)).trim());
  }
  return out;
}

function readJsonDir<T>(dir: string, schema: z.ZodType<T>): Map<string, T> {
  const out = new Map<string, T>();
  if (!statExists(dir) || !statSync(dir).isDirectory()) return out;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const parsed: unknown = JSON.parse(readFile(join(dir, name)));
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new BundleError(
        `${name} is malformed: ${result.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    out.set(name.slice(0, -".json".length), result.data);
  }
  return out;
}

function optionalJson<T>(path: string, schema: z.ZodType<T>): T | undefined {
  if (!statExists(path)) return undefined;
  const result = schema.safeParse(JSON.parse(readFile(path)));
  if (!result.success) throw new BundleError(`${path} is malformed`);
  return result.data;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new BundleError(`missing ${path}`);
  }
}

function readBytes(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new BundleError(`missing ${path}`);
  }
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export { utf8 };
