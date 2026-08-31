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
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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

/** The cart the closed mandate hashes. Payee may live only on the signed closed claims. */
export const BoundCartSchema = z
  .object({
    total_paise: z.number().int().nonnegative(),
    currency: z.string().length(3).optional(),
    payee: z.object({ id: z.string().min(1) }).optional(),
    rail: z.string().min(1).optional(),
    // The policy replay must see the same category the server decided with,
    // or every ALLOW under a category allow-list false-fails P1.
    category: z.string().min(1).optional(),
  })
  .passthrough();

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
    // Razorpay's own attestation, over a secret only they and the merchant
    // hold, that this payment belongs to this order. The offline verifier
    // cannot re-check that HMAC (it has no key secret), so it is exported for
    // transparency as a merchant-asserted fact, not proven here — see
    // docs/LIMITATIONS.md.
    signature_verified: z.boolean().optional(),
    amount_paise: z.number().int().nonnegative(),
    currency: z.string().length(3),
    seq: z.number().int().nonnegative(),
    record_hash: z.string().min(1),
    tree_size: z.number().int().nonnegative(),
    leaf_hash: z.string().min(1),
    root: z.string().min(1),
    proof: z.array(z.string()),
    checkpoint_note: z.string().min(1),
    /** Sealed record so a counterparty can bind amount/order/payment without the log. */
    record: AuditRecordSchema,
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
  const { root, tempDir } = expand(path);
  try {
    const manifest = readManifest(root);
    assertManifest(root, manifest);

    // Everything is read eagerly, so an archive's extraction is disposable
    // the moment this returns — nothing below holds a path into it.
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
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  }
}

/** An evidence bundle is a few hundred small files; 10k entries is hostile. */
const MAX_BUNDLE_ENTRIES = 10_000;

/** Cap on DECOMPRESSED bytes, so a kilobyte bomb cannot fill the disk. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/** A directory is used in place; an archive is extracted into a temp dir the caller must remove. */
function expand(path: string): { root: string; tempDir: string | undefined } {
  if (!statExists(path)) throw new BundleError(`bundle not found: ${path}`);

  if (statSync(path).isDirectory()) return { root: path, tempDir: undefined };

  if (!/\.(tar\.gz|tgz)$/.test(path)) {
    throw new BundleError(`bundle must be a directory or a .tar.gz, got ${path}`);
  }

  const dest = mkdtempSync(join(tmpdir(), "countersign-bundle-"));
  try {
    const listing = execFileSync("tar", ["-tzf", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const names = listing.split("\n").filter((line) => line.length > 0);
    if (names.length > MAX_BUNDLE_ENTRIES) {
      throw new BundleError(
        `archive has ${names.length} entries; refusing over ${MAX_BUNDLE_ENTRIES}`,
      );
    }
    for (const name of names) {
      assertSafeTarMember(name);
    }

    // Typeflags are checked BEFORE extraction. A symlink member with files
    // extracted through it afterwards writes outside the bundle DURING
    // extraction; the post-hoc walk below would find the symlink only after
    // the damage was done. The first column of `tar -tv` is the typeflag in
    // both GNU tar and bsdtar: `l` is a symlink, `h` a hardlink.
    const verbose = execFileSync("tar", ["-tvzf", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of verbose.split("\n").filter((l) => l.length > 0)) {
      if (line.startsWith("l") || line.startsWith("h")) {
        throw new BundleError(`refusing link entry in archive: ${line}`);
      }
    }

    // Bound the decompressed stream. `head` truncates at the cap and tar
    // then fails on the incomplete archive, so a bomb dies at the limit
    // instead of at disk exhaustion. Arguments are positional — nothing
    // caller-controlled is interpolated into the script text.
    execFileSync(
      "sh",
      [
        "-c",
        'gunzip -c -- "$1" | head -c "$2" | tar -xf - -C "$3"',
        "sh",
        path,
        String(MAX_BUNDLE_BYTES),
        dest,
      ],
      { stdio: "pipe" },
    );
    assertNoSymlinks(dest);
  } catch (error) {
    // A refused archive must not leave its partial extraction behind: a
    // decompression bomb that dies at the 512 MB cap would otherwise leave
    // up to 512 MB in the auditor's temp dir per attempt.
    rmSync(dest, { recursive: true, force: true });
    if (error instanceof BundleError) throw error;
    throw new BundleError(`failed to unpack ${path}: ${(error as Error).message}`);
  }

  const entries = readdirSync(dest);
  if (entries.length === 1) {
    const nested = join(dest, entries[0] as string);
    if (statExists(nested) && statSync(nested).isDirectory())
      return { root: nested, tempDir: dest };
  }
  return { root: dest, tempDir: dest };
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
  if (!("records.jsonl" in manifest.files)) {
    throw new BundleError("MANIFEST.json does not list records.jsonl");
  }

  for (const [relative, expected] of Object.entries(manifest.files)) {
    const bytes = readBytes(assertInside(root, relative));
    const actual = digestB64u(bytes);
    if (actual !== expected) {
      throw new BundleError(
        `MANIFEST.json digest mismatch for ${relative}: declared ${expected}, file is ${actual}`,
      );
    }
  }

  for (const relative of evidenceFiles(root)) {
    if (!(relative in manifest.files)) {
      throw new BundleError(`${relative} is present but not listed in MANIFEST.json`);
    }
  }
}

function evidenceFiles(root: string): string[] {
  const out: string[] = [];
  const addFile = (relative: string): void => {
    const path = join(root, relative);
    if (statExists(path) && statSync(path).isFile()) out.push(relative);
  };

  addFile("records.jsonl");
  addFile("policy/engine.json");
  for (const dir of ["checkpoints", "mandates", "checkouts", "receipts"]) {
    const path = join(root, dir);
    if (!statExists(path) || !statSync(path).isDirectory()) continue;
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isFile()) out.push(`${dir}/${name}`);
    }
  }
  return out;
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
    const stem = name.slice(0, -".note".length);
    if (!/^(0|[1-9][0-9]*)$/.test(stem)) {
      throw new BundleError(`checkpoint filename ${name} is not <tree_size>.note`);
    }
    const size = Number(stem);
    if (!Number.isSafeInteger(size)) {
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
  refuseSymlink(path);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new BundleError(`missing ${path}`);
  }
}

function readBytes(path: string): Uint8Array {
  refuseSymlink(path);
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new BundleError(`missing ${path}`);
  }
}

/** Reject absolute names, `..`, and `~`. Used before system tar extracts. */
export function assertSafeTarMember(name: string): void {
  const trimmed = name.replace(/^\.\//, "");
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.split(/[/\\]/).includes("..")) {
    throw new BundleError(`refusing path outside bundle: ${name}`);
  }
}

export function assertInside(root: string, relative: string): string {
  assertSafeTarMember(relative);
  const resolved = resolve(root, relative);
  const base = resolve(root);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new BundleError(`refusing path outside bundle: ${relative}`);
  }
  return resolved;
}

function refuseSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new BundleError(`refusing symlink ${path}`);
    }
  } catch (error) {
    if (error instanceof BundleError) throw error;
  }
}

function assertNoSymlinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new BundleError(`refusing symlink ${entry.name}`);
    }
    if (entry.isDirectory()) assertNoSymlinks(path);
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
