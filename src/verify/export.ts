/**
 * Write an audit bundle to a directory.
 *
 * Used by tests and, later, by the export endpoint. The MANIFEST is computed
 * from the files as written, so a caller cannot declare a digest that does
 * not match the bytes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditRecord } from "../audit/record.js";
import { digestB64u } from "../crypto/digest.js";
import { utf8 } from "../crypto/encoding.js";
import type { CheckoutFile, ReceiptFile } from "./bundle.js";

export interface BundleInput {
  readonly records: readonly AuditRecord[];
  readonly checkpoints: Readonly<Record<number, string>>;
  readonly mandates: Readonly<Record<string, string>>;
  readonly checkouts: Readonly<Record<string, CheckoutFile>>;
  readonly receipts: Readonly<Record<string, ReceiptFile>>;
  readonly policy?: { readonly engine_version: string; readonly bundle_sha256: string };
  readonly createdAt?: string;
}

export function writeBundle(root: string, input: BundleInput): void {
  mkdirSync(root, { recursive: true });

  const files: Record<string, Uint8Array> = {};

  files["records.jsonl"] = utf8(
    input.records.map((r) => JSON.stringify(r)).join("\n") + (input.records.length > 0 ? "\n" : ""),
  );

  for (const [size, note] of Object.entries(input.checkpoints)) {
    files[`checkpoints/${size}.note`] = utf8(note.endsWith("\n") ? note : `${note}\n`);
  }
  for (const [jti, jws] of Object.entries(input.mandates)) {
    files[`mandates/${jti}.jws`] = utf8(`${jws}\n`);
  }
  for (const [jti, checkout] of Object.entries(input.checkouts)) {
    files[`checkouts/${jti}.json`] = utf8(`${JSON.stringify(checkout, null, 2)}\n`);
  }
  for (const [receipt, body] of Object.entries(input.receipts)) {
    files[`receipts/${receipt}.json`] = utf8(`${JSON.stringify(body, null, 2)}\n`);
  }
  if (input.policy !== undefined) {
    files["policy/engine.json"] = utf8(`${JSON.stringify(input.policy, null, 2)}\n`);
  }

  const listed: Record<string, string> = {};
  for (const [relative, bytes] of Object.entries(files)) {
    listed[relative] = digestB64u(bytes);
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  const manifest = {
    v: 1 as const,
    created_at: input.createdAt ?? new Date().toISOString(),
    files: listed,
  };
  writeFileSync(join(root, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
