-- Razorpay integration: outbound calls, payment state, and webhook ingestion.

-- ---------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------

-- "Write to the database, then call the API" is a dual-write: the process can
-- die between the two, and there is no ordering of those steps that is safe.
-- Commit the intent to call as part of the same transaction, and let a
-- separate worker perform it.
--
-- The consequence worth stating: delivery is at-least-once, so every outbound
-- call must be idempotent at the far end. That is what the derived receipt and
-- the Razorpay idempotency key are for.
CREATE TABLE outbox (
	id            TEXT        PRIMARY KEY,
	kind          TEXT        NOT NULL,

	-- Ordering key. Calls sharing one are performed in sequence, so a capture
	-- cannot overtake the order that created it.
	stream        TEXT        NOT NULL,

	payload       JSONB       NOT NULL,
	state         TEXT        NOT NULL DEFAULT 'pending'
	                          CHECK (state IN ('pending', 'in_flight', 'done', 'in_doubt', 'failed')),
	attempts      INTEGER     NOT NULL DEFAULT 0,

	-- Set when a worker claims the row; lets a crashed worker's claim expire
	-- instead of stranding the message.
	lease_expires_at TIMESTAMPTZ,

	next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	last_error       TEXT,
	result           JSONB,
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outbox_ready ON outbox (next_attempt_at)
	WHERE state IN ('pending', 'in_doubt');

CREATE INDEX outbox_stream ON outbox (stream, created_at);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
	-- Our reference, derived deterministically from the mandate and request.
	-- Unique here as well as at Razorpay: two lines of defence against the
	-- same purchase being placed twice.
	receipt          TEXT        PRIMARY KEY,

	authorization_id TEXT        NOT NULL UNIQUE,
	open_jti         TEXT        NOT NULL,
	closed_jti       TEXT        NOT NULL UNIQUE,

	order_id         TEXT        UNIQUE,
	payment_id       TEXT        UNIQUE,

	amount_minor     BIGINT      NOT NULL CHECK (amount_minor > 0),
	currency         CHAR(3)     NOT NULL,

	state            TEXT        NOT NULL
	                             CHECK (state IN ('created', 'authorized', 'failed', 'captured', 'refunded')),

	-- A timeout is not a failure; it means we do not know. Resolved by asking
	-- Razorpay about OUR reference rather than by retrying with a fresh one.
	in_doubt         BOOLEAN     NOT NULL DEFAULT FALSE,
	in_doubt_reason  TEXT,

	-- Razorpay attesting, under a shared secret, that this payment belongs to
	-- this order. We cannot manufacture it, which is what makes it evidence.
	signature        TEXT,
	signature_verified BOOLEAN   NOT NULL DEFAULT FALSE,

	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

	CHECK (in_doubt = FALSE OR in_doubt_reason IS NOT NULL),
	CHECK (signature_verified = FALSE OR signature IS NOT NULL)
);

CREATE INDEX payments_in_doubt ON payments (updated_at) WHERE in_doubt;
CREATE INDEX payments_by_mandate ON payments (open_jti);

-- ---------------------------------------------------------------------------
-- Webhook ingestion
-- ---------------------------------------------------------------------------

-- Dedupe is the primary key, not a SELECT followed by an INSERT. Razorpay
-- retries, and two retries can arrive concurrently; a read-then-write races and
-- processes both.
CREATE TABLE webhook_events (
	event_id     TEXT        PRIMARY KEY,
	event        TEXT        NOT NULL,
	payment_id   TEXT,
	order_id     TEXT,

	-- The raw body as delivered. The signature covers these exact bytes, so a
	-- reserialised copy could never be re-verified.
	raw_body     BYTEA       NOT NULL,
	signature    TEXT        NOT NULL,

	received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	processed_at TIMESTAMPTZ,

	-- Recorded even when it changed nothing. "We saw this and declined to
	-- regress the state" is the answer reconciliation needs later.
	applied      BOOLEAN,
	outcome      TEXT
);

CREATE INDEX webhook_events_unprocessed ON webhook_events (received_at)
	WHERE processed_at IS NULL;

CREATE INDEX webhook_events_by_payment ON webhook_events (payment_id)
	WHERE payment_id IS NOT NULL;
