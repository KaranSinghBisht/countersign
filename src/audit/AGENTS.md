# Audit log

extracted_at: 2026-08-22

Hash chain + RFC 6962 Merkle tree + Ed25519 checkpoint. This is what a third party checks.

- `record_hash = b64u(SHA256(JCS(record without record_hash)))`. `hashRecord` strips `record_hash` rather than assuming it absent — spreading a sealed record into a patch otherwise keeps the old hash and presents as tampering.
- Genesis is the constant `countersign/v1/genesis`, not null. Null genesis lets an attacker truncate the log and present the survivor as the start.
- Sequencing locks `audit_head`. A Postgres `SEQUENCE` is non-transactional; a rollback burns a number; a gap is indistinguishable from a deletion.
- Merkle: `leaf = SHA256(0x00 ‖ d)`, `node = SHA256(0x01 ‖ l ‖ r)`. The prefixes are the whole point. `merkletreejs` omits them by default. Prove and verify are written from different definitions so a bug cannot cancel in a round trip.
- Checkpoints: transparency-dev signed-note. Verify against a key the **caller** pins. Every size is retained; republishing a different note at a published size is a fork and is refused.
- Every record carries `spent_before_paise` / `amount_paise` / `spent_after_paise`. Drop a middle record, repair `prev_hash` and `seq`, and L6 still reports the paise unaccounted for.
- DENY and ESCALATE are logged as carefully as ALLOW. `spent_after` on a refusal is counterfactual; the next record continues from `spent_before`.
- HTTP `/audit/*` serves what was stored. The checkpoint note is returned verbatim. Reserialising it changes the bytes the signature covers.

The verifier lives in `src/verify/`. It does not read a key out of this log.
