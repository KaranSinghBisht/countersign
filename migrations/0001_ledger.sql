-- Double-entry ledger.
--
-- Three properties this schema enforces in the database rather than in
-- application code, because application code is what has bugs:
--
--   1. Every transaction balances to zero, per currency.
--   2. Posted entries are immutable — no UPDATE, no DELETE, no TRUNCATE.
--   3. Balances are DERIVED. There is no balance column to drift.
--
-- Money is a signed count of minor units in a BIGINT. Debits are positive,
-- credits negative, and "balances" therefore means "sums to zero", which is a
-- constraint the database can check without understanding accounting.

CREATE TABLE ledger_accounts (
	id         TEXT        NOT NULL,
	kind       TEXT        NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
	currency   CHAR(3)     NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

	-- Currency is part of the key, not an attribute. An account holds exactly
	-- one currency, so "receivable" in INR and in USD are two accounts that
	-- can never be added together by accident. It also gives entries a
	-- composite foreign key target, so an entry cannot claim a currency its
	-- account does not hold — enforced by a key rather than a trigger.
	PRIMARY KEY (id, currency)
);

CREATE TABLE ledger_transactions (
	id           TEXT PRIMARY KEY,
	kind         TEXT        NOT NULL CHECK (kind IN ('hold', 'capture', 'release', 'fee', 'refund')),
	occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
	open_jti     TEXT,
	closed_jti   TEXT,
	external_ref TEXT,
	memo         TEXT        NOT NULL
);

CREATE INDEX ledger_transactions_open_jti ON ledger_transactions (open_jti);

CREATE TABLE ledger_entries (
	id             BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	transaction_id TEXT    NOT NULL REFERENCES ledger_transactions (id),
	account_id     TEXT    NOT NULL,
	currency       CHAR(3) NOT NULL,

	-- A zero-value entry carries no information and would let a transaction
	-- "balance" with a single meaningless row.
	amount_minor   BIGINT  NOT NULL CHECK (amount_minor <> 0),

	FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency)
);

CREATE INDEX ledger_entries_transaction ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, currency);

-- ---------------------------------------------------------------------------
-- Balance enforcement
-- ---------------------------------------------------------------------------

CREATE FUNCTION assert_transaction_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	offending RECORD;
BEGIN
	SELECT e.transaction_id, e.currency, SUM(e.amount_minor) AS total
	  INTO offending
	  FROM ledger_entries e
	 WHERE e.transaction_id = NEW.transaction_id
	 GROUP BY e.transaction_id, e.currency
	HAVING SUM(e.amount_minor) <> 0
	 LIMIT 1;

	IF FOUND THEN
		RAISE EXCEPTION
			'ledger transaction % does not balance in %: entries sum to %',
			offending.transaction_id, offending.currency, offending.total
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NULL;
END;
$$;

-- DEFERRABLE INITIALLY DEFERRED is the whole point: entries are inserted one
-- row at a time, so the sum is only meaningful once the statement's work is
-- done. A non-deferred check would fire on the first leg of every transfer and
-- reject it for being unbalanced, which it always is at that instant.
CREATE CONSTRAINT TRIGGER ledger_entries_balance
	AFTER INSERT ON ledger_entries
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION assert_transaction_balances();

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------

CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION
		'ledger_entries is append-only; % is not permitted. Post a reversing entry instead.',
		TG_OP
		USING ERRCODE = 'raise_exception';
END;
$$;

-- A trigger rather than only REVOKE, because REVOKE does not bind the table
-- owner and this must hold for every role including the one migrations run as.
-- The grants below are defence in depth for a least-privilege deployment; the
-- trigger is what actually makes the guarantee true today.
CREATE TRIGGER ledger_entries_no_update
	BEFORE UPDATE OR DELETE ON ledger_entries
	FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER ledger_entries_no_truncate
	BEFORE TRUNCATE ON ledger_entries
	FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();

-- ---------------------------------------------------------------------------
-- Derived balances
-- ---------------------------------------------------------------------------

-- A view, never a column. A stored balance is a second source of truth that
-- drifts from the entries the moment anything goes wrong, and reconciliation
-- then has two candidates for "what we think we hold" with no way to choose.
CREATE VIEW ledger_balances AS
SELECT
	a.id       AS account_id,
	a.kind     AS kind,
	a.currency AS currency,
	COALESCE(SUM(e.amount_minor), 0)::BIGINT AS balance_minor,
	COUNT(e.id)                              AS entry_count
FROM ledger_accounts a
LEFT JOIN ledger_entries e
	ON e.account_id = a.id AND e.currency = a.currency
GROUP BY a.id, a.kind, a.currency;
