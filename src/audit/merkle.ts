/**
 * RFC 6962 Merkle tree, hand-written.
 *
 * The two domain-separation prefixes are the entire point:
 *
 *   leaf(d)    = SHA256(0x00 ‖ d)
 *   node(l, r) = SHA256(0x01 ‖ l ‖ r)
 *
 * Without them a leaf and an interior node are drawn from the same space, so
 * an attacker who controls a leaf can submit the concatenation of two existing
 * node hashes and have it interpreted as an interior node — a second-preimage
 * attack that forges inclusion proofs for entries never logged.
 *
 * `merkletreejs` does not apply these prefixes by default. That is why this is
 * written out rather than imported, and why it is tested against the published
 * RFC 6962 vectors rather than against itself.
 *
 * The prove and verify sides are deliberately written from different
 * definitions: proving follows the RFC's recursive PATH/PROOF specification,
 * verifying follows its iterative §2.1.1/§2.1.2 algorithms. A single shared
 * helper would let one bug cancel itself out and pass every round-trip test.
 */

import { sha256 } from "@noble/hashes/sha2.js";

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

/** MTH({}) — the hash of the empty string, per RFC 6962 §2.1. */
export function emptyRoot(): Uint8Array {
  return sha256(new Uint8Array(0));
}

export function leafHash(entry: Uint8Array): Uint8Array {
  return sha256(concat(LEAF_PREFIX, entry));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concat(NODE_PREFIX, left, right));
}

/**
 * The largest power of two strictly less than n, for n > 1.
 *
 * RFC 6962 splits at this point rather than at the midpoint, which is what
 * makes every left subtree complete and lets a tree grow without reshaping the
 * parts already committed to.
 */
function splitPoint(n: number): number {
  // Multiply rather than shift: `k << 1` is a 32-bit op in JS, so a tree
  // larger than 2^30 would wrap and split at the wrong place.
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH(D[n]) over raw entries. */
export function root(entries: readonly Uint8Array[]): Uint8Array {
  if (entries.length === 0) return emptyRoot();
  if (entries.length === 1) return leafHash(entries[0] as Uint8Array);

  const k = splitPoint(entries.length);
  return nodeHash(root(entries.slice(0, k)), root(entries.slice(k)));
}

// ---------------------------------------------------------------------------
// Inclusion
// ---------------------------------------------------------------------------

/** PATH(m, D[n]) — the audit path proving entry m belongs to the tree. */
export function inclusionProof(m: number, entries: readonly Uint8Array[]): Uint8Array[] {
  const n = entries.length;
  if (m < 0 || m >= n) throw new RangeError(`leaf index ${m} outside a tree of size ${n}`);
  if (n === 1) return [];

  const k = splitPoint(n);
  return m < k
    ? [...inclusionProof(m, entries.slice(0, k)), root(entries.slice(k))]
    : [...inclusionProof(m - k, entries.slice(k)), root(entries.slice(0, k))];
}

/**
 * RFC 6962 §2.1.1, iteratively.
 *
 * Takes the LEAF HASH rather than the entry, because that is what a verifier
 * holding only a record actually has, and it keeps the caller honest about
 * which of the two hashes it is passing.
 */
export function verifyInclusion(
  m: number,
  n: number,
  leaf: Uint8Array,
  proof: readonly Uint8Array[],
  expectedRoot: Uint8Array,
): boolean {
  if (m < 0 || n <= 0 || m >= n) return false;

  let fn = m;
  let sn = n - 1;
  let r = leaf;

  for (const p of proof) {
    // The path ran longer than the tree is deep, so it does not describe
    // this tree. Accepting the surplus would accept a forged proof.
    if (sn === 0) return false;

    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        do {
          fn >>>= 1;
          sn >>>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      r = nodeHash(r, p);
    }

    fn >>>= 1;
    sn >>>= 1;
  }

  // sn must be exhausted: a short path leaves unconsumed tree.
  return sn === 0 && equal(r, expectedRoot);
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/**
 * PROOF(m, D[n]) — evidence that the size-m tree is a prefix of the size-n one.
 *
 * This is what makes the log append-only in a way anyone can check. An
 * inclusion proof says "this record is in the tree"; a consistency proof says
 * "nothing that was in the old tree has been altered or removed", which is the
 * claim that actually matters for an audit log.
 */
export function consistencyProof(m: number, entries: readonly Uint8Array[]): Uint8Array[] {
  const n = entries.length;
  if (m < 0 || m > n) throw new RangeError(`cannot prove size ${m} against size ${n}`);
  if (m === 0 || m === n) return [];
  return subproof(m, entries, true);
}

function subproof(
  m: number,
  entries: readonly Uint8Array[],
  isCompleteSubtree: boolean,
): Uint8Array[] {
  const n = entries.length;

  // The old tree is exactly this subtree. If it is a complete subtree of the
  // new one the verifier can recompute its root unaided, so sending it would
  // be redundant; otherwise the root must be supplied.
  if (m === n) return isCompleteSubtree ? [] : [root(entries)];

  const k = splitPoint(n);
  return m <= k
    ? [...subproof(m, entries.slice(0, k), isCompleteSubtree), root(entries.slice(k))]
    : [...subproof(m - k, entries.slice(k), false), root(entries.slice(0, k))];
}

/** RFC 6962 §2.1.2, iteratively. */
export function verifyConsistency(
  first: number,
  second: number,
  firstRoot: Uint8Array,
  secondRoot: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  if (first < 0 || second < 0 || first > second) return false;

  // Every tree is consistent with the empty tree, and with itself — but only
  // if the roots actually agree, which a caller replaying old checkpoints
  // against a forked log needs checked rather than assumed.
  if (first === 0) return proof.length === 0;
  if (first === second) return proof.length === 0 && equal(firstRoot, secondRoot);

  // A complete-subtree old root is omitted from the wire form because the
  // verifier can derive it; put it back before running the algorithm.
  const path = isPowerOfTwo(first) ? [firstRoot, ...proof] : [...proof];

  const seed = path[0];
  if (seed === undefined) return false;

  let fn = first - 1;
  let sn = second - 1;

  while ((fn & 1) === 1) {
    fn >>>= 1;
    sn >>>= 1;
  }

  let fr = seed;
  let sr = seed;

  for (const c of path.slice(1)) {
    if (sn === 0) return false;

    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if ((fn & 1) === 0) {
        do {
          fn >>>= 1;
          sn >>>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      sr = nodeHash(sr, c);
    }

    fn >>>= 1;
    sn >>>= 1;
  }

  return sn === 0 && equal(fr, firstRoot) && equal(sr, secondRoot);
}

// ---------------------------------------------------------------------------

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Constant-time-ish comparison. Merkle roots are public, so this is not
 * guarding a secret; it is here so that no caller is tempted to compare hashes
 * with `===` on a Uint8Array, which is always false and would make every
 * verification silently fail closed in the most confusing possible way.
 */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
