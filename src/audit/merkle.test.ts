import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hex, hexDecode } from "../crypto/encoding.js";
import {
  consistencyProof,
  emptyRoot,
  inclusionProof,
  leafHash,
  nodeHash,
  root,
  verifyConsistency,
  verifyInclusion,
} from "./merkle.js";

/**
 * The eight test entries from RFC 6962, as used by the Certificate
 * Transparency reference implementations.
 *
 * These are the whole reason this file exists. Testing a Merkle tree against
 * itself proves only that it is self-consistent, which a tree with no domain
 * separation at all would also manage.
 */
const ENTRIES = [
  "",
  "00",
  "10",
  "2021",
  "3031",
  "40414243",
  "5051525354555657",
  "606162636465666768696a6b6c6d6e6f",
].map(hexDecode);

/** Published MTH(D[n]) for n = 0..8. */
const ROOTS = [
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

describe("RFC 6962 published vectors", () => {
  it("reproduces MTH(D[n]) for every prefix of the test data", () => {
    for (const [n, expected] of ROOTS.entries()) {
      expect(hex(root(ENTRIES.slice(0, n))), `tree size ${n}`).toBe(expected);
    }
  });

  it("hashes the empty tree as SHA-256 of the empty string", () => {
    expect(hex(emptyRoot())).toBe(ROOTS[0]);
  });

  it("prefixes leaves with 0x00", () => {
    // SHA-256 of a single zero byte, i.e. leaf("").
    expect(hex(leafHash(new Uint8Array(0)))).toBe(
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    );
    // leaf(0x00) = SHA-256(0x00 0x00).
    expect(hex(leafHash(Uint8Array.of(0x00)))).toBe(
      "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
    );
  });

  it("separates the leaf and node domains", () => {
    // The attack the prefixes exist to stop: without them, node(a, b) and a
    // leaf whose data happens to be a‖b hash identically, so an attacker who
    // can log one crafted entry can forge inclusion proofs for entries that
    // were never logged.
    const a = leafHash(Uint8Array.of(1));
    const b = leafHash(Uint8Array.of(2));

    const interior = nodeHash(a, b);
    const forged = leafHash(Uint8Array.from([...a, ...b]));

    expect(hex(interior)).not.toBe(hex(forged));
  });
});

describe("inclusion proofs", () => {
  it("matches the published audit path for leaf 0 of an 8-entry tree", () => {
    expect(inclusionProof(0, ENTRIES).map(hex)).toEqual([
      "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
      "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
      "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4",
    ]);
  });

  it("matches the published audit path for leaf 5 of an 8-entry tree", () => {
    expect(inclusionProof(5, ENTRIES).map(hex)).toEqual([
      "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
      "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0",
      "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    ]);
  });

  it("verifies every leaf of every tree size", () => {
    for (let n = 1; n <= ENTRIES.length; n++) {
      const entries = ENTRIES.slice(0, n);
      const r = root(entries);

      for (let m = 0; m < n; m++) {
        const proof = inclusionProof(m, entries);
        const leaf = leafHash(entries[m] as Uint8Array);

        expect(verifyInclusion(m, n, leaf, proof, r), `leaf ${m} of ${n}`).toBe(true);
      }
    }
  });

  it("rejects a proof replayed at the wrong index", () => {
    const r = root(ENTRIES);
    const proof = inclusionProof(3, ENTRIES);
    const leaf = leafHash(ENTRIES[3] as Uint8Array);

    expect(verifyInclusion(3, 8, leaf, proof, r)).toBe(true);
    expect(verifyInclusion(4, 8, leaf, proof, r)).toBe(false);
  });

  it("rejects a proof for an entry that was never logged", () => {
    const r = root(ENTRIES);
    const proof = inclusionProof(3, ENTRIES);

    expect(verifyInclusion(3, 8, leafHash(hexDecode("deadbeef")), proof, r)).toBe(false);
  });

  it("rejects a tampered path element", () => {
    const r = root(ENTRIES);
    const proof = inclusionProof(3, ENTRIES);
    const leaf = leafHash(ENTRIES[3] as Uint8Array);

    const tampered = [...proof];
    tampered[1] = leafHash(hexDecode("00"));

    expect(verifyInclusion(3, 8, leaf, tampered, r)).toBe(false);
  });

  it("rejects paths of the wrong length", () => {
    const r = root(ENTRIES);
    const proof = inclusionProof(3, ENTRIES);
    const leaf = leafHash(ENTRIES[3] as Uint8Array);

    // Truncated leaves tree unconsumed; extended runs past the root. Both are
    // how a forged proof for a tree of a different size would present.
    expect(verifyInclusion(3, 8, leaf, proof.slice(0, -1), r)).toBe(false);
    expect(verifyInclusion(3, 8, leaf, [...proof, leaf], r)).toBe(false);
  });

  it("rejects an out-of-range index", () => {
    const r = root(ENTRIES);
    const leaf = leafHash(ENTRIES[0] as Uint8Array);

    expect(verifyInclusion(8, 8, leaf, [], r)).toBe(false);
    expect(verifyInclusion(-1, 8, leaf, [], r)).toBe(false);
    expect(verifyInclusion(0, 0, leaf, [], r)).toBe(false);
  });
});

describe("consistency proofs", () => {
  it("verifies every (m, n) pair over the test data", () => {
    for (let n = 1; n <= ENTRIES.length; n++) {
      const newRoot = root(ENTRIES.slice(0, n));

      for (let m = 0; m <= n; m++) {
        const oldRoot = root(ENTRIES.slice(0, m));
        const proof = consistencyProof(m, ENTRIES.slice(0, n));

        expect(verifyConsistency(m, n, oldRoot, newRoot, proof), `${m} → ${n}`).toBe(true);
      }
    }
  });

  it("refuses a tree that dropped an entry", () => {
    // The property that makes the log append-only. Rewriting history has to
    // fail even though the tampered tree is internally well-formed.
    const original = ENTRIES.slice(0, 4);
    const oldRoot = root(original);

    const rewritten = [...ENTRIES.slice(0, 2), ...ENTRIES.slice(3, 8)];
    const newRoot = root(rewritten);
    const proof = consistencyProof(4, rewritten);

    expect(verifyConsistency(4, 7, oldRoot, newRoot, proof)).toBe(false);
  });

  it("refuses a tree that altered an old entry", () => {
    const oldRoot = root(ENTRIES.slice(0, 4));

    const tampered = [...ENTRIES];
    tampered[1] = hexDecode("ff");
    const proof = consistencyProof(4, tampered);

    expect(verifyConsistency(4, 8, oldRoot, root(tampered), proof)).toBe(false);
  });

  it("treats the empty tree as consistent with everything", () => {
    expect(verifyConsistency(0, 8, emptyRoot(), root(ENTRIES), [])).toBe(true);
  });

  it("requires the roots to agree when the size did not change", () => {
    const r = root(ENTRIES);

    expect(verifyConsistency(8, 8, r, r, [])).toBe(true);
    // A fork: same size, different history. An implementation that
    // short-circuits on first === second without comparing roots accepts this.
    expect(verifyConsistency(8, 8, r, root(ENTRIES.slice(0, 7)), [])).toBe(false);
  });

  it("refuses to shrink", () => {
    expect(verifyConsistency(8, 4, root(ENTRIES), root(ENTRIES.slice(0, 4)), [])).toBe(false);
  });

  it("rejects a tampered consistency path", () => {
    const oldRoot = root(ENTRIES.slice(0, 3));
    const newRoot = root(ENTRIES);
    const proof = consistencyProof(3, ENTRIES);

    const tampered = [...proof];
    tampered[0] = leafHash(hexDecode("00"));

    expect(verifyConsistency(3, 8, oldRoot, newRoot, tampered)).toBe(false);
  });
});

describe("properties", () => {
  const entryList = fc.array(fc.uint8Array({ maxLength: 24 }), { minLength: 1, maxLength: 40 });

  it("verifies any honestly produced inclusion proof", () => {
    fc.assert(
      fc.property(entryList, fc.nat(), (entries, seed) => {
        const m = seed % entries.length;
        const leaf = leafHash(entries[m] as Uint8Array);

        return verifyInclusion(m, entries.length, leaf, inclusionProof(m, entries), root(entries));
      }),
    );
  });

  it("verifies any honestly produced consistency proof", () => {
    fc.assert(
      fc.property(entryList, fc.nat(), (entries, seed) => {
        const m = seed % (entries.length + 1);
        const oldRoot = root(entries.slice(0, m));

        return verifyConsistency(
          m,
          entries.length,
          oldRoot,
          root(entries),
          consistencyProof(m, entries),
        );
      }),
    );
  });

  it("changes the root whenever any entry changes", () => {
    fc.assert(
      fc.property(entryList, fc.nat(), fc.uint8Array({ maxLength: 24 }), (entries, seed, next) => {
        const m = seed % entries.length;
        if (hex(entries[m] as Uint8Array) === hex(next)) return true;

        const altered = [...entries];
        altered[m] = next;

        return hex(root(entries)) !== hex(root(altered));
      }),
    );
  });

  it("appending never changes what an old inclusion proof proves", () => {
    // Old proofs stay valid against the old root: a checkpoint handed to a
    // counterparty last week is still checkable today.
    fc.assert(
      fc.property(entryList, entryList, fc.nat(), (entries, extra, seed) => {
        const m = seed % entries.length;
        const proof = inclusionProof(m, entries);
        const leaf = leafHash(entries[m] as Uint8Array);

        return verifyInclusion(
          m,
          entries.length,
          leaf,
          proof,
          root(entries.slice(0, entries.length)),
        )
          ? verifyInclusion(
              m,
              entries.length,
              leaf,
              proof,
              root([...entries, ...extra].slice(0, entries.length)),
            )
          : false;
      }),
    );
  });
});
