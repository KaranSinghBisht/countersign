-- The evidence the audit record can only point at.
--
-- A record commits to open_hash/closed_hash/request_hash, but a third-party
-- verifier needs the artifacts themselves: the raw JWSes to re-verify the
-- signatures, and the checkout to re-derive the request hash. Stored in the
-- same transaction as the decision they belong to, so an exported bundle is
-- assembled from rows that committed together with the audit record.

CREATE TABLE mandate_artifacts (
	closed_jti  TEXT        PRIMARY KEY,
	open_jti    TEXT        NOT NULL,

	-- Exact bytes as presented. A reserialised JWS would not re-verify.
	open_jws    TEXT        NOT NULL,
	closed_jws  TEXT        NOT NULL,

	nonce       TEXT        NOT NULL,
	checkout    JSONB       NOT NULL,
	request     JSONB       NOT NULL,

	created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mandate_artifacts_by_open ON mandate_artifacts (open_jti);
