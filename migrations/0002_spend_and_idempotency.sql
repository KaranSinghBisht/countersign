-- Spend accounting, replay protection, idempotency, and authorization state.
--
-- Unlike ledger_entries, most of these tables are mutable. That is deliberate:
-- the ledger is the immutable record of what happened, and these are the
-- working state used to decide what happens next. Conflating the two is how
-- ledgers end up with status columns.

-- ---------------------------------------------------------------------------
-- Spend accounting
-- ---------------------------------------------------------------------------

-- One row per open mandate. This row is the serialization point: concurrent
-- purchases under the same mandate take a FOR UPDATE lock on it, which is what
-- stops twenty simultaneous requests from all reading the same balance and all
-- concluding there is room.
CREATE TABLE mandate_spend (
	open_jti     TEXT        PRIMARY KEY,
	currency     CHAR(3)     NOT NULL,
	spent_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (spent_minor >= 0),
	actions      INTEGER     NOT NULL DEFAULT 0 CHECK (actions >= 0),
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every settled action, for the rolling velocity window. Append-only in
-- practice; the policy engine reads it to decide whether a burst is within the
-- permitted rate.
CREATE TABLE mandate_actions (
	closed_jti   TEXT        PRIMARY KEY,
	open_jti     TEXT        NOT NULL REFERENCES mandate_spend (open_jti),
	amount_minor BIGINT      NOT NULL CHECK (amount_minor > 0),
	currency     CHAR(3)     NOT NULL,
	occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mandate_actions_window ON mandate_actions (open_jti, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Replay protection
-- ---------------------------------------------------------------------------

-- A closed mandate authorises exactly one purchase. The primary key is the
-- guard: the second attempt to spend it raises 23505 rather than being caught
-- by an `if (await alreadyUsed(jti))`, which is a TOCTOU race that two
-- concurrent requests slip straight through.
CREATE TABLE consumed_mandates (
	closed_jti  TEXT        PRIMARY KEY,
	open_jti    TEXT        NOT NULL,
	consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-issued challenge nonces. `jti` is chosen by the agent, so a
-- compromised agent can pre-mint mandates; the mandate must also commit to a
-- value WE chose after the request began.
CREATE TABLE nonces (
	nonce       TEXT        PRIMARY KEY,
	issued_to   TEXT        NOT NULL,
	issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at  TIMESTAMPTZ NOT NULL,
	consumed_at TIMESTAMPTZ,

	CHECK (expires_at > issued_at)
);

CREATE INDEX nonces_expiry ON nonces (expires_at) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Authorizations
-- ---------------------------------------------------------------------------

CREATE TABLE authorizations (
	id           TEXT        PRIMARY KEY,
	open_jti     TEXT        NOT NULL,
	closed_jti   TEXT        NOT NULL UNIQUE,
	state        TEXT        NOT NULL CHECK (state IN ('authorized', 'captured', 'released', 'failed')),
	amount_minor BIGINT      NOT NULL CHECK (amount_minor > 0),
	currency     CHAR(3)     NOT NULL,
	external_ref TEXT,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AP2's one-in-flight rule, as a partial unique index rather than a check in
-- application code. At most one outstanding authorization per open mandate,
-- enforced for every writer and under every interleaving.
CREATE UNIQUE INDEX one_outstanding_authorization_per_mandate
	ON authorizations (open_jti)
	WHERE state = 'authorized';

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

-- The key row is committed BEFORE any outbound call to Razorpay. That ordering
-- is the entire guarantee: if the process dies mid-call, the key still exists
-- and the retry finds it rather than issuing a second payment.
--
-- `fingerprint` is a digest of the canonicalised request. Reusing a key with a
-- different body is a client bug that must be reported (422), never silently
-- served the first response.
CREATE TABLE idempotency_keys (
	actor_id         TEXT        NOT NULL,
	idem_key         TEXT        NOT NULL,
	fingerprint      TEXT        NOT NULL,
	state            TEXT        NOT NULL CHECK (state IN ('in_flight', 'succeeded', 'failed')),

	-- A crashed request would otherwise hold the key forever. The lease lets a
	-- later attempt take over once it has demonstrably expired, which is
	-- recovery without an external reaper process.
	lease_expires_at TIMESTAMPTZ NOT NULL,

	response_status  INTEGER,
	response_body    JSONB,
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

	PRIMARY KEY (actor_id, idem_key),

	-- A terminal state must carry the response it is going to replay, and an
	-- in-flight one must not pretend to have one.
	CHECK (
		(state = 'in_flight' AND response_status IS NULL)
		OR (state <> 'in_flight' AND response_status IS NOT NULL)
	)
);

CREATE INDEX idempotency_keys_leases
	ON idempotency_keys (lease_expires_at)
	WHERE state = 'in_flight';
