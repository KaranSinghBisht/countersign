-- Dedupe webhooks by what Razorpay SIGNED, not by what it merely sent.
--
-- x-razorpay-event-id is a header outside the signature. An attacker who
-- captures one legitimately signed body can replay it forever with fresh
-- event ids; every copy passes signature verification and lands as a new
-- row. State stays correct (applying the same transition twice is a no-op)
-- but the table grows without bound and the processing queue does the work.
-- The body digest closes that: identical signed bytes are one event.

ALTER TABLE webhook_events ADD COLUMN body_sha256 TEXT;

UPDATE webhook_events
   SET body_sha256 = encode(sha256(raw_body), 'hex')
 WHERE body_sha256 IS NULL;

ALTER TABLE webhook_events ALTER COLUMN body_sha256 SET NOT NULL;

CREATE UNIQUE INDEX webhook_events_body_sha256_key ON webhook_events (body_sha256);
