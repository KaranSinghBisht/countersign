-- A worker that dies mid-tick leaves its outbox message in_flight with a lease
-- that will lapse. claim() now reclaims those rows once the lease expires;
-- the existing outbox_ready index covers only pending/in_doubt, so give the
-- reclaim path its own.
CREATE INDEX IF NOT EXISTS outbox_stranded
  ON outbox (lease_expires_at)
  WHERE state = 'in_flight';
