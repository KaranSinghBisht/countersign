-- The append-only audit log and its checkpoints.

CREATE TABLE audit_records (
	seq         BIGINT      PRIMARY KEY,
	record_hash TEXT        NOT NULL UNIQUE,
	prev_hash   TEXT        NOT NULL,

	-- Denormalised out of the record body so the common queries — "everything
	-- under this mandate", "this order" — do not have to search JSONB.
	open_jti    TEXT        NOT NULL,
	closed_jti  TEXT,
	order_id    TEXT,
	decision    TEXT        NOT NULL CHECK (decision IN ('ALLOW', 'DENY', 'ESCALATE')),

	-- The record exactly as it was hashed. Stored whole because a verifier must
	-- be able to recompute record_hash from what it was given, and a
	-- reassembled-from-columns record would differ the moment this schema
	-- gains a column.
	record      JSONB       NOT NULL,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_records_by_mandate ON audit_records (open_jti, seq);
CREATE INDEX audit_records_by_order ON audit_records (order_id) WHERE order_id IS NOT NULL;

CREATE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	-- Named from TG_TABLE_NAME rather than hardcoded: this trigger guards both
	-- audit_records and checkpoints, and an error naming the wrong table sends
	-- whoever hits it looking in the wrong place.
	RAISE EXCEPTION
		'% is append-only; % is not permitted.',
		TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER audit_records_no_update
	BEFORE UPDATE OR DELETE ON audit_records
	FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TRIGGER audit_records_no_truncate
	BEFORE TRUNCATE ON audit_records
	FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

-- The serialization point for appends.
--
-- Sequence numbers must be gapless and prev_hash must chain, so appends cannot
-- run concurrently. A Postgres SEQUENCE is explicitly the wrong tool: it is
-- non-transactional and leaves gaps on rollback, and a gap is indistinguishable
-- from a deletion to anyone auditing the log.
--
-- One row, enforced by the primary key. `CHECK (id)` means the only permitted
-- value is true, so a second row cannot be inserted.
CREATE TABLE audit_head (
	id        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
	next_seq  BIGINT  NOT NULL DEFAULT 0,
	last_hash TEXT    NOT NULL DEFAULT 'countersign/v1/genesis'
);

INSERT INTO audit_head (id) VALUES (TRUE);

CREATE TABLE checkpoints (
	tree_size  BIGINT      PRIMARY KEY,
	root_hash  BYTEA       NOT NULL,

	-- The signed note verbatim. Reserialising it would change the bytes the
	-- signature covers.
	note       TEXT        NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

	CHECK (octet_length(root_hash) = 32)
);

CREATE TRIGGER checkpoints_no_update
	BEFORE UPDATE OR DELETE ON checkpoints
	FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
