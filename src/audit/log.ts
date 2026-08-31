/**
 * The append-only log: sequencing, storage, proofs and checkpoints.
 *
 * Appending takes a lock on a single head row. That looks like a bottleneck
 * and is a deliberate one — sequence numbers have to be gapless and `prev_hash`
 * has to chain, and neither survives concurrent appends. A Postgres SEQUENCE
 * would be faster and wrong: it is non-transactional, so a rolled-back
 * transaction burns a number, and a gap in an audit log is indistinguishable
 * from a deletion to whoever is auditing it.
 *
 * `append` takes a transaction rather than a connection, so the audit record
 * commits with the spend that produced it. If the log could succeed while the
 * spend failed — or the reverse — replaying the log would no longer reproduce
 * the balance, and the verifiability claim would be hollow.
 */

import { b64Decode, utf8 } from "../crypto/encoding.js";
import type { KeyPair } from "../crypto/keys.js";
import type { Sql, TransactionSql } from "../db/client.js";
import { body, type Checkpoint, sign } from "./checkpoint.js";
import { consistencyProof, inclusionProof, leafHash, root } from "./merkle.js";
import {
  type AuditRecord,
  AuditRecordSchema,
  GENESIS_HASH,
  seal,
  type UnsealedRecord,
  verifyRecordChain,
} from "./record.js";

/** Everything except the fields the log itself assigns. */
export type AppendInput = Omit<UnsealedRecord, "seq" | "prev_hash" | "v">;

export async function append(tx: TransactionSql, input: AppendInput): Promise<AuditRecord> {
  // FOR UPDATE on the single head row. Concurrent appends queue here, which
  // is what makes seq gapless and the chain well-formed.
  const head = await tx<{ next_seq: bigint; last_hash: string }[]>`
		SELECT next_seq, last_hash FROM audit_head WHERE id = TRUE FOR UPDATE
	`;

  const current = head[0];
  if (current === undefined) throw new Error("audit_head row is missing; run migrations");

  const record = seal({
    ...input,
    v: 1,
    seq: Number(current.next_seq),
    prev_hash: current.last_hash,
  });

  // Parsed before it is stored, not after. A malformed record that reaches
  // the table cannot be removed — the table refuses UPDATE and DELETE — so
  // the only place to reject it is here.
  const parsed = AuditRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(
      `refusing to append a malformed audit record: ` +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  await tx`
		INSERT INTO audit_records (seq, record_hash, prev_hash, open_jti, closed_jti, order_id, decision, record)
		VALUES (
			${record.seq}, ${record.record_hash}, ${record.prev_hash},
			${record.mandate.open_jti}, ${record.mandate.closed_jti},
			${record.external?.order_id ?? null}, ${record.decision},
			${tx.json(record as never)}
		)
	`;

  await tx`
		UPDATE audit_head
		   SET next_seq = ${record.seq + 1}, last_hash = ${record.record_hash}
		 WHERE id = TRUE
	`;

  return record;
}

export async function size(sql: Sql | TransactionSql): Promise<number> {
  const rows = await sql<{ next_seq: bigint }[]>`SELECT next_seq FROM audit_head WHERE id = TRUE`;
  return Number(rows[0]?.next_seq ?? 0);
}

export async function read(
  sql: Sql | TransactionSql,
  from = 0,
  limit = 1000,
): Promise<AuditRecord[]> {
  const rows = await sql<{ record: AuditRecord }[]>`
		SELECT record FROM audit_records
		 WHERE seq >= ${from}
		 ORDER BY seq
		 LIMIT ${limit}
	`;
  return rows.map((r) => r.record);
}

/**
 * Every record behind a Razorpay order.
 *
 * A live record is appended at intent time, before the worker has talked to
 * Razorpay, and is immutable afterwards — so its own `order_id` is null. The
 * order is known to the payment row instead; resolving through it is what
 * lets a settlement dispute walk from an order id back to the decision.
 */
export async function readByOrder(sql: Sql, orderId: string): Promise<AuditRecord[]> {
  const rows = await sql<{ record: AuditRecord }[]>`
		SELECT record FROM audit_records
		 WHERE order_id = ${orderId}
		    OR record->'mandate'->>'closed_jti' IN (
		         SELECT closed_jti FROM payments WHERE order_id = ${orderId}
		       )
		 ORDER BY seq
	`;
  return rows.map((r) => r.record);
}

// ---------------------------------------------------------------------------
// Merkle view
// ---------------------------------------------------------------------------

/**
 * The Merkle leaf for a record.
 *
 * The leaf commits to the record's HASH, not to the record body. That keeps
 * the leaf a fixed 32 bytes and, more usefully, lets an inclusion proof be
 * checked by someone holding only a receipt — they never need the full record,
 * which may contain more than they are entitled to see.
 */
export function leafFor(record: AuditRecord): Uint8Array {
  return utf8(record.record_hash);
}

// Prefix cache for the Merkle view. The log is append-only and a sealed
// record never changes, so a hash read once stays valid; every proof used to
// re-read the entire log, which made a public, unauthenticated endpoint cost
// O(records) per request forever. The one thing that can invalidate a prefix
// is the log being reset underneath a live process (a test truncate), which
// the tail check catches by re-reading a single row.
let cachedHashes: string[] = [];
let cachedLeaves: Uint8Array[] = [];

async function leaves(sql: Sql | TransactionSql, upTo: number): Promise<Uint8Array[]> {
  if (cachedHashes.length > 0) {
    const tail = cachedHashes.length - 1;
    const check = await sql<{ record_hash: string }[]>`
			SELECT record_hash FROM audit_records WHERE seq = ${tail}
		`;
    if (check[0]?.record_hash !== cachedHashes[tail]) {
      cachedHashes = [];
      cachedLeaves = [];
    }
  }

  if (cachedHashes.length < upTo) {
    const rows = await sql<{ seq: number | bigint; record_hash: string }[]>`
			SELECT seq, record_hash FROM audit_records
			 WHERE seq >= ${cachedHashes.length} AND seq < ${upTo}
			 ORDER BY seq
		`;
    for (const r of rows) {
      // Two concurrent readers can both fetch the same tail; only the first
      // to arrive extends the cache, the other's rows are already present.
      // (The driver returns int8 as bigint — compare as a number.)
      if (Number(r.seq) !== cachedHashes.length) continue;
      cachedHashes.push(r.record_hash);
      cachedLeaves.push(utf8(r.record_hash));
    }
  }

  return cachedLeaves.slice(0, upTo);
}

export async function treeRoot(sql: Sql, treeSize?: number): Promise<Uint8Array> {
  const n = treeSize ?? (await size(sql));
  return root(await leaves(sql, n));
}

export interface InclusionEvidence {
  readonly seq: number;
  readonly treeSize: number;
  readonly leafHash: Uint8Array;
  readonly proof: Uint8Array[];
  readonly root: Uint8Array;
}

export async function proveInclusion(
  sql: Sql,
  seq: number,
  treeSize?: number,
): Promise<InclusionEvidence> {
  const n = treeSize ?? (await size(sql));
  if (seq < 0 || seq >= n) throw new RangeError(`seq ${seq} is outside a log of size ${n}`);

  const entries = await leaves(sql, n);

  return {
    seq,
    treeSize: n,
    leafHash: leafHash(entries[seq] as Uint8Array),
    proof: inclusionProof(seq, entries),
    root: root(entries),
  };
}

/**
 * Inclusion evidence for many records from ONE read of the leaves — what an
 * export wants. Calling proveInclusion per record re-reads the prefix each
 * time, which made exporting quadratic in the size of the log.
 */
export async function proveInclusionMany(
  sql: Sql | TransactionSql,
  seqs: readonly number[],
  treeSize: number,
): Promise<Map<number, InclusionEvidence>> {
  const entries = await leaves(sql, treeSize);
  const treeRootHash = root(entries);
  const out = new Map<number, InclusionEvidence>();
  for (const seq of seqs) {
    if (seq < 0 || seq >= treeSize) {
      throw new RangeError(`seq ${seq} is outside a log of size ${treeSize}`);
    }
    out.set(seq, {
      seq,
      treeSize,
      leafHash: leafHash(entries[seq] as Uint8Array),
      proof: inclusionProof(seq, entries),
      root: treeRootHash,
    });
  }
  return out;
}

export async function proveConsistency(
  sql: Sql,
  from: number,
  to?: number,
): Promise<{ from: number; to: number; proof: Uint8Array[] }> {
  const n = to ?? (await size(sql));
  return { from, to: n, proof: consistencyProof(from, await leaves(sql, n)) };
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface CheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly note: string;
  readonly createdAt: Date;
}

/**
 * Sign the current tree and store the note.
 *
 * Storing every checkpoint rather than only the latest is what makes a split
 * view detectable after the fact. If we kept only the newest, a log that
 * briefly served a forked history could quietly converge and leave no trace.
 */
export async function publishCheckpoint(
  sql: Sql,
  origin: string,
  keyName: string,
  key: KeyPair,
): Promise<CheckpointRecord> {
  const n = await size(sql);
  const checkpoint: Checkpoint = { origin, size: n, rootHash: await treeRoot(sql, n) };
  const note = await sign(checkpoint, keyName, key);

  // A checkpoint at a size we have already published must be byte-identical.
  // Ed25519 is deterministic, so re-publishing an unchanged tree produces the
  // same note; a DIFFERENT note at the same size means the tree changed
  // underneath us, which is exactly the fork we want to refuse to record.
  const stored = await sql<{ note: string }[]>`
		INSERT INTO checkpoints (tree_size, root_hash, note)
		VALUES (${n}, ${Buffer.from(checkpoint.rootHash)}, ${note})
		ON CONFLICT (tree_size) DO NOTHING
		RETURNING note
	`;

  if (stored.length === 0) {
    const existing = await sql<{ note: string }[]>`
			SELECT note FROM checkpoints WHERE tree_size = ${n}
		`;
    const previous = existing[0]?.note;

    if (previous !== note) {
      throw new Error(
        `refusing to publish: a different checkpoint already exists at size ${n}. ` +
          `The log has forked, or history was rewritten.`,
      );
    }
  }

  return { checkpoint, note, createdAt: new Date() };
}

/** Every published checkpoint, oldest first. The exporter ships all of them. */
export async function allCheckpoints(
  sql: Sql | TransactionSql,
): Promise<{ size: number; note: string }[]> {
  const rows = await sql<{ tree_size: bigint; note: string }[]>`
		SELECT tree_size, note FROM checkpoints ORDER BY tree_size
	`;
  return rows.map((row) => ({ size: Number(row.tree_size), note: row.note }));
}

export async function latestCheckpoint(
  sql: Sql | TransactionSql,
): Promise<CheckpointRecord | undefined> {
  const rows = await sql<
    { tree_size: bigint; root_hash: Buffer; note: string; created_at: Date }[]
  >`
		SELECT tree_size, root_hash, note, created_at
		  FROM checkpoints ORDER BY tree_size DESC LIMIT 1
	`;

  const row = rows[0];
  if (row === undefined) return undefined;

  return {
    checkpoint: {
      // Origin lives in the note; recovering it from there keeps one source
      // of truth for what was signed.
      origin: row.note.split("\n")[0] as string,
      size: Number(row.tree_size),
      rootHash: new Uint8Array(row.root_hash),
    },
    note: row.note,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------

/**
 * Verify the stored log end to end: hashes, links, and the running totals.
 *
 * This is the same function the offline verifier uses, pointed at our own
 * database. Running it against ourselves is not evidence for anyone else — the
 * point of the exported bundle is that a third party can run it without us —
 * but it does catch the case where our own writer has a bug.
 */
export async function selfCheck(sql: Sql): Promise<ReturnType<typeof verifyRecordChain>> {
  return verifyRecordChain(await read(sql, 0, Number.MAX_SAFE_INTEGER));
}

export { b64Decode, body as checkpointBody, GENESIS_HASH };
