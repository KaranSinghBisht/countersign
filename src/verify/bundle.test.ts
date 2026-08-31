import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestB64u } from "../crypto/digest.js";
import { utf8 } from "../crypto/encoding.js";
import { assertSafeTarMember, BundleError, loadBundle } from "./bundle.js";
import { writeBundle } from "./export.js";

describe("writeBundle", () => {
  it("clears evidence left by an earlier export so MANIFEST stays complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-reexport-"));
    const base = { records: [], mandates: {}, checkouts: {}, receipts: {} };

    // First export sealed at size 2, second at size 1: the 2.note must go,
    // or the loader rejects the bundle as carrying an unlisted file.
    writeBundle(dir, { ...base, checkpoints: { 2: "note-two\n" } });
    writeBundle(dir, { ...base, checkpoints: { 1: "note-one\n" } });

    expect(existsSync(join(dir, "checkpoints", "2.note"))).toBe(false);
    expect(existsSync(join(dir, "checkpoints", "1.note"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files).sort()).toEqual(["checkpoints/1.note", "records.jsonl"]);
  });
});

describe("bundle path guards", () => {
  it("refuses tar members that escape the dest dir", () => {
    expect(() => assertSafeTarMember("../secret")).toThrow(BundleError);
    expect(() => assertSafeTarMember("/etc/passwd")).toThrow(BundleError);
    expect(() => assertSafeTarMember("checkpoints/../../keys")).toThrow(BundleError);
    expect(() => assertSafeTarMember("records.jsonl")).not.toThrow();
    expect(() => assertSafeTarMember("./checkpoints/1.note")).not.toThrow();
  });

  it("rejects scientific-notation checkpoint filenames", () => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-note-"));
    const records = "";
    const note = "not-a-note\n";
    writeFileSync(join(dir, "records.jsonl"), records);
    mkdirSync(join(dir, "checkpoints"));
    writeFileSync(join(dir, "checkpoints", "1e3.note"), note);
    writeFileSync(
      join(dir, "MANIFEST.json"),
      `${JSON.stringify({
        v: 1,
        created_at: "2026-08-22T00:00:00.000Z",
        files: {
          "records.jsonl": digestB64u(utf8(records)),
          "checkpoints/1e3.note": digestB64u(utf8(note)),
        },
      })}\n`,
    );

    expect(() => loadBundle(dir)).toThrow(/tree_size/);
  });

  it("refuses evidence files that are not in MANIFEST.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-extra-"));
    const records = "";
    writeFileSync(join(dir, "records.jsonl"), records);
    mkdirSync(join(dir, "checkpoints"));
    writeFileSync(join(dir, "checkpoints", "1.note"), "note\n");
    writeFileSync(
      join(dir, "MANIFEST.json"),
      `${JSON.stringify({
        v: 1,
        created_at: "2026-08-22T00:00:00.000Z",
        files: { "records.jsonl": digestB64u(utf8(records)) },
      })}\n`,
    );

    expect(() => loadBundle(dir)).toThrow(/not listed in MANIFEST/);
  });

  it("requires records.jsonl to be listed", () => {
    const dir = mkdtempSync(join(tmpdir(), "countersign-nolist-"));
    writeFileSync(join(dir, "records.jsonl"), "");
    writeFileSync(
      join(dir, "MANIFEST.json"),
      `${JSON.stringify({ v: 1, created_at: "2026-08-22T00:00:00.000Z", files: {} })}\n`,
    );

    expect(() => loadBundle(dir)).toThrow(/records\.jsonl/);
  });
});
