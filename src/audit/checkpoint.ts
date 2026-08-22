/**
 * Checkpoints, in the transparency-dev signed-note format.
 *
 *   <origin>\n
 *   <tree_size>\n
 *   <base64 root hash>\n
 *   \n
 *   — <key name> <base64 keyhash+signature>\n
 *
 * The blank line matters: everything above it is the signed body, everything
 * below is signatures. That split is what lets a note carry several signatures
 * — a log's own, plus a witness's — without any of them having to agree on an
 * encoding first.
 *
 * Reusing this format rather than inventing one means `cosign`-adjacent tools
 * and anyone who has read the Go transparency stack already knows how to read
 * our output, and it keeps the signed bytes unambiguous. Ed25519 here rather
 * than ES256 because checkpoint signatures are deterministic, so re-signing an
 * unchanged checkpoint is a no-op instead of producing a new artifact.
 */

import type { JWK } from "jose";
import { digest } from "../crypto/digest.js";
import { b64, b64Decode, utf8 } from "../crypto/encoding.js";
import type { KeyPair, PublicKeyRef } from "../crypto/keys.js";
import { publicKeyBytes, signRaw, verifyRaw } from "../crypto/keys.js";

export interface Checkpoint {
  readonly origin: string;
  readonly size: number;
  readonly rootHash: Uint8Array;
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

/** The signed body. Exactly these bytes are what a signature covers. */
export function body(checkpoint: Checkpoint): string {
  if (!Number.isInteger(checkpoint.size) || checkpoint.size < 0) {
    throw new CheckpointError(`tree size must be a non-negative integer, got ${checkpoint.size}`);
  }
  // A newline inside the origin would forge the line structure, letting one
  // note be read as another with a different size or root.
  if (checkpoint.origin.includes("\n") || checkpoint.origin.length === 0) {
    throw new CheckpointError("origin must be a non-empty single line");
  }

  return `${checkpoint.origin}\n${checkpoint.size}\n${b64(checkpoint.rootHash)}\n`;
}

/**
 * The 4-byte key hash that prefixes a signature.
 *
 * It identifies which key signed without naming it, so a verifier holding
 * several trusted keys can pick the right one before doing the expensive part.
 * It is not a security boundary: the signature is.
 */
export function keyHash(keyName: string, publicJwk: JWK): Uint8Array {
  // The Go note package hashes name ‖ 0x0A ‖ algorithm ‖ key bytes. Raw key
  // bytes rather than the JWK, since a JWK has many serialisations and would
  // give a different key hash depending on which one you happened to produce.
  const material = new Uint8Array([...utf8(`${keyName}\n`), 0x01, ...publicKeyBytes(publicJwk)]);
  return digest(material).slice(0, 4);
}

export async function sign(checkpoint: Checkpoint, keyName: string, key: KeyPair): Promise<string> {
  const signed = body(checkpoint);
  const signature = await signRaw(utf8(signed), key);
  const blob = new Uint8Array([...keyHash(keyName, key.publicJwk), ...signature]);

  return `${signed}\n\u2014 ${keyName} ${b64(blob)}\n`;
}

export interface VerifiedCheckpoint extends Checkpoint {
  readonly keyName: string;
}

/**
 * Parse and verify a note against a key the CALLER already trusts.
 *
 * The key is a parameter and never read from the note. A verifier that learns
 * its key from the artifact under inspection verifies nothing at all — that is
 * the entire point of the exercise, and it is an easy line to write by accident
 * when the note conveniently contains a key name.
 */
export async function verify(
  note: string,
  expectedOrigin: string,
  keyName: string,
  key: PublicKeyRef,
): Promise<VerifiedCheckpoint> {
  const separator = note.indexOf("\n\n");
  if (separator === -1)
    throw new CheckpointError("malformed note: no blank line before signatures");

  const signedBody = note.slice(0, separator + 1);
  const signatureBlock = note.slice(separator + 2);

  const lines = signedBody.split("\n");
  // origin, size, root, and the trailing empty string after the final \n.
  if (lines.length !== 4) {
    throw new CheckpointError(`malformed note: expected 3 body lines, got ${lines.length - 1}`);
  }

  const [origin, sizeText, rootText] = lines as [string, string, string, string];

  if (origin !== expectedOrigin) {
    throw new CheckpointError(`origin is "${origin}", expected "${expectedOrigin}"`);
  }

  // Reject "1e3", "+7", " 7" and leading zeros: each would parse to a number
  // while re-serialising to different bytes than were signed.
  if (!/^(0|[1-9][0-9]*)$/.test(sizeText)) {
    throw new CheckpointError(`malformed tree size: "${sizeText}"`);
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) throw new CheckpointError(`tree size out of range: ${sizeText}`);

  const rootHash = b64Decode(rootText);
  if (rootHash.length !== 32) {
    throw new CheckpointError(`expected a 32-byte root hash, got ${rootHash.length}`);
  }

  const signature = findSignature(signatureBlock, keyName, key);
  if (signature === undefined) {
    throw new CheckpointError(`no signature from "${keyName}"`);
  }

  if (!(await verifyRaw(utf8(signedBody), signature, key))) {
    throw new CheckpointError(`signature from "${keyName}" does not verify`);
  }

  return { origin, size, rootHash, keyName };
}

function findSignature(block: string, keyName: string, key: PublicKeyRef): Uint8Array | undefined {
  const expected = keyHash(keyName, key.jwk);

  for (const line of block.split("\n")) {
    if (line.length === 0) continue;

    const match = /^\u2014 (\S+) (\S+)$/.exec(line);
    if (match === null) continue;

    const [, name, encoded] = match as unknown as [string, string, string];
    if (name !== keyName) continue;

    let blob: Uint8Array;
    try {
      blob = b64Decode(encoded);
    } catch {
      continue;
    }

    if (blob.length < 5) continue;
    if (!blob.slice(0, 4).every((byte, i) => byte === expected[i])) continue;

    return blob.slice(4);
  }

  return undefined;
}

/**
 * Reject a checkpoint that does not extend the one before it.
 *
 * A log that goes backwards, or that reissues a size with a different root,
 * has forked. Both are what a split-view attack looks like from the outside —
 * the log shows one history to one party and a different one to another — and
 * neither is caught by verifying signatures, because the attacker holds the
 * signing key and every note is perfectly valid on its own.
 */
export function assertExtends(
  previous: Checkpoint,
  next: Checkpoint,
  previousAt: Date,
  nextAt: Date,
): void {
  if (next.origin !== previous.origin) {
    throw new CheckpointError(`origin changed from "${previous.origin}" to "${next.origin}"`);
  }

  if (next.size < previous.size) {
    throw new CheckpointError(
      `tree shrank from ${previous.size} to ${next.size}; a log may only append`,
    );
  }

  if (next.size === previous.size && !equal(next.rootHash, previous.rootHash)) {
    throw new CheckpointError(`two different roots at size ${next.size}: the log has forked`);
  }

  if (nextAt.getTime() < previousAt.getTime()) {
    throw new CheckpointError(
      `checkpoint timestamp went backwards: ${nextAt.toISOString()} < ${previousAt.toISOString()}`,
    );
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
