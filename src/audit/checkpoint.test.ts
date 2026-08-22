import { beforeAll, describe, expect, it } from "vitest";
import { b64, utf8 } from "../crypto/encoding.js";
import { generateKey, importPublicKey, type KeyPair, type PublicKeyRef } from "../crypto/keys.js";
import {
  assertExtends,
  body,
  type Checkpoint,
  CheckpointError,
  keyHash,
  sign,
  verify,
} from "./checkpoint.js";
import { emptyRoot, root } from "./merkle.js";

const ORIGIN = "countersign.dev/audit";
const KEY_NAME = "countersign.dev/audit";

let key: KeyPair;
let pub: PublicKeyRef;
let other: KeyPair;
let otherPub: PublicKeyRef;

beforeAll(async () => {
  key = await generateKey("Ed25519");
  pub = await importPublicKey(key.publicJwk);
  other = await generateKey("Ed25519");
  otherPub = await importPublicKey(other.publicJwk);
});

const at = (seconds: number) => new Date(seconds * 1000);

function checkpoint(size: number, entries: readonly Uint8Array[] = []): Checkpoint {
  return { origin: ORIGIN, size, rootHash: size === 0 ? emptyRoot() : root(entries) };
}

const ENTRIES = [utf8("a"), utf8("b"), utf8("c")];

describe("note format", () => {
  it("lays out origin, size and root on three lines", () => {
    const text = body(checkpoint(3, ENTRIES));
    const lines = text.split("\n");

    expect(lines[0]).toBe(ORIGIN);
    expect(lines[1]).toBe("3");
    expect(lines[2]).toBe(b64(root(ENTRIES)));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("separates the signed body from signatures with a blank line", () => {
    // Everything above the blank line is signed; everything below is
    // signatures. That split is what lets a witness co-sign a note later
    // without renegotiating an encoding.
    const note = body(checkpoint(3, ENTRIES));
    expect(note.includes("\n\n")).toBe(false);
  });

  it("refuses an origin containing a newline", () => {
    // Otherwise an origin forges the line structure and one note reads as
    // another with a different size or root.
    expect(() => body({ origin: "evil\n99", size: 0, rootHash: emptyRoot() })).toThrow(
      CheckpointError,
    );
  });

  it("refuses a negative or fractional size", () => {
    expect(() => body({ origin: ORIGIN, size: -1, rootHash: emptyRoot() })).toThrow(
      CheckpointError,
    );
    expect(() => body({ origin: ORIGIN, size: 1.5, rootHash: emptyRoot() })).toThrow(
      CheckpointError,
    );
  });
});

describe("signing and verifying", () => {
  it("round-trips", async () => {
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);
    const verified = await verify(note, ORIGIN, KEY_NAME, pub);

    expect(verified.size).toBe(3);
    expect(b64(verified.rootHash)).toBe(b64(root(ENTRIES)));
    expect(verified.keyName).toBe(KEY_NAME);
  });

  it("produces the same bytes for the same checkpoint", async () => {
    // Ed25519 is deterministic, so re-signing an unchanged checkpoint is a
    // no-op rather than a new artifact. ES256 would emit a different note
    // every time and make checkpoints look like they had changed.
    const a = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);
    const b = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);

    expect(a).toBe(b);
  });

  it("rejects a note signed by a different key", async () => {
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, other);

    await expect(verify(note, ORIGIN, KEY_NAME, pub)).rejects.toThrow(CheckpointError);
  });

  it("rejects a tampered size", async () => {
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);
    const tampered = note.replace(`\n3\n`, `\n4\n`);

    await expect(verify(tampered, ORIGIN, KEY_NAME, pub)).rejects.toThrow(/does not verify/);
  });

  it("rejects a tampered root", async () => {
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);
    const tampered = note.replace(b64(root(ENTRIES)), b64(root(ENTRIES.slice(0, 2))));

    await expect(verify(tampered, ORIGIN, KEY_NAME, pub)).rejects.toThrow(/does not verify/);
  });

  it("rejects a note from an unexpected origin", async () => {
    // A valid signature over someone else's log is still not our log.
    const note = await sign(
      { ...checkpoint(3, ENTRIES), origin: "evil.test/audit" },
      KEY_NAME,
      key,
    );

    await expect(verify(note, ORIGIN, KEY_NAME, pub)).rejects.toThrow(/origin is/);
  });

  it("never learns its key from the note", async () => {
    // The whole point of a verifier. A note names a key; trusting that name
    // would let any note nominate the key that checks it.
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, other);

    // Same key NAME, attacker's key material. Only the caller's pinned key
    // decides, so this must fail.
    await expect(verify(note, ORIGIN, KEY_NAME, pub)).rejects.toThrow(CheckpointError);
    await expect(verify(note, ORIGIN, KEY_NAME, otherPub)).resolves.toMatchObject({ size: 3 });
  });

  it("rejects non-canonical sizes that reserialise differently", async () => {
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);

    // "03" and "+3" both parse to 3 while being different signed bytes.
    for (const forged of ["\n03\n", "\n+3\n", "\n 3\n", "\n3e0\n"]) {
      await expect(verify(note.replace("\n3\n", forged), ORIGIN, KEY_NAME, pub)).rejects.toThrow(
        CheckpointError,
      );
    }
  });

  it("rejects a note with no signature block", async () => {
    await expect(verify(body(checkpoint(3, ENTRIES)), ORIGIN, KEY_NAME, pub)).rejects.toThrow(
      /no blank line/,
    );
  });

  it("rejects a signature attributed to an unknown key name", async () => {
    const note = await sign(checkpoint(3, ENTRIES), KEY_NAME, key);

    await expect(verify(note, ORIGIN, "someone.else/audit", pub)).rejects.toThrow(/no signature/);
  });

  it("handles the empty log", async () => {
    const note = await sign(checkpoint(0), KEY_NAME, key);
    const verified = await verify(note, ORIGIN, KEY_NAME, pub);

    expect(verified.size).toBe(0);
    expect(b64(verified.rootHash)).toBe(b64(emptyRoot()));
  });

  it("derives a key hash from key bytes, not from the JWK", async () => {
    // A JWK has many serialisations; key bytes have one. Two names over one
    // key, and one name over two keys, must all differ.
    expect(b64(keyHash(KEY_NAME, key.publicJwk))).not.toBe(b64(keyHash("other", key.publicJwk)));
    expect(b64(keyHash(KEY_NAME, key.publicJwk))).not.toBe(b64(keyHash(KEY_NAME, other.publicJwk)));
    expect(keyHash(KEY_NAME, key.publicJwk)).toHaveLength(4);
  });
});

describe("monotonicity", () => {
  it("accepts growth", () => {
    expect(() =>
      assertExtends(checkpoint(2, ENTRIES.slice(0, 2)), checkpoint(3, ENTRIES), at(100), at(200)),
    ).not.toThrow();
  });

  it("accepts a reissued checkpoint at the same size", () => {
    expect(() =>
      assertExtends(checkpoint(3, ENTRIES), checkpoint(3, ENTRIES), at(100), at(200)),
    ).not.toThrow();
  });

  it("refuses a log that shrank", () => {
    expect(() =>
      assertExtends(checkpoint(3, ENTRIES), checkpoint(2, ENTRIES.slice(0, 2)), at(100), at(200)),
    ).toThrow(/may only append/);
  });

  it("catches a split view: two roots at one size", () => {
    // The attack signatures cannot catch, because the log holds the signing
    // key and both notes verify perfectly. Only comparing them does it — which
    // is why checkpoints are meant to be gossiped rather than merely served.
    const shown = checkpoint(3, ENTRIES);
    const hidden = checkpoint(3, [utf8("a"), utf8("b"), utf8("evil")]);

    expect(() => assertExtends(shown, hidden, at(100), at(200))).toThrow(/forked/);
  });

  it("refuses a timestamp that goes backwards", () => {
    expect(() =>
      assertExtends(checkpoint(2, ENTRIES.slice(0, 2)), checkpoint(3, ENTRIES), at(200), at(100)),
    ).toThrow(/backwards/);
  });

  it("refuses a change of origin", () => {
    expect(() =>
      assertExtends(
        checkpoint(2, ENTRIES.slice(0, 2)),
        { ...checkpoint(3, ENTRIES), origin: "elsewhere" },
        at(100),
        at(200),
      ),
    ).toThrow(/origin changed/);
  });
});
