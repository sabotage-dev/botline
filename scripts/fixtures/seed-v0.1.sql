-- Rows a v0.1 database held, for scripts/migration-test.sh. Times are fixed so a content hash is stable. The key of agent
-- `alpha` is the test key bl_AAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB (migration-test.sh computes the same hash).
INSERT INTO agents (workspace_id, id, name, key_hash, allowed_senders, doorbell_kind, doorbell_url, doorbell_secret, created_at) VALUES
  ('default', 'alpha', 'Alpha', '__ALPHA_HASH__', '*', 'none', NULL, NULL, '2026-10-13T00:00:00.000Z'),
  ('default', 'beta', 'Beta', 'hash-beta', '["alpha"]', 'generic_webhook', 'https://relay.example.invalid/hook', 'plaintext-secret', '2026-10-13T00:00:01.000Z');
INSERT INTO messages (workspace_id, id, thread_id, hop_count, from_agent, to_agents, subject, body, needs, idempotency_key, created_at, expires_at, meta) VALUES
  ('default', 'msg_seed1', 'thr_seed', 0, 'alpha', '["beta"]', 'first', 'first body', 'reply', 'seed-key-1', '2026-10-13T01:00:00.000Z', '2999-01-01T00:00:00.000Z', '{"a":1}'),
  ('default', 'msg_seed2', 'thr_seed', 1, 'beta', '["alpha"]', 'second', 'second body', 'none', NULL, '2026-10-13T01:01:00.000Z', '2999-01-01T00:00:00.000Z', '{}');
INSERT INTO receipts (workspace_id, message_id, agent, delivered_at, read_at, acked_at) VALUES
  ('default', 'msg_seed1', 'beta', '2026-10-13T01:00:01.000Z', '2026-10-13T01:00:10.000Z', '2026-10-13T01:01:00.000Z'),
  ('default', 'msg_seed2', 'alpha', NULL, NULL, NULL);
INSERT INTO rings (workspace_id, agent, last_status, last_at, fail_count) VALUES ('default', 'beta', 'ok', '2026-10-13T01:00:01.000Z', 0);
INSERT INTO ring_log (workspace_id, agent, kind, status, http_status, message_ids, at) VALUES ('default', 'beta', 'generic_webhook', 'ok', 200, '["msg_seed1"]', '2026-10-13T01:00:01.000Z');
