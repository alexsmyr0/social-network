-- Refuse a lossy downgrade; restore a coordinated backup instead. A retry nonce is
-- data, and a cursor is data unless it still equals its migration bootstrap value.
CREATE TEMP TABLE b22_refuse_down(value INTEGER NOT NULL CHECK(value=1));
INSERT INTO b22_refuse_down SELECT NOT(
 EXISTS(SELECT 1 FROM private_messages WHERE client_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM dm_read_cursors c WHERE c.through_id<>COALESCE((
  SELECT MAX(m.id) FROM private_messages m
  WHERE (m.sender_id=c.viewer_id AND m.recipient_id=c.other_id) OR (m.sender_id=c.other_id AND m.recipient_id=c.viewer_id)),0)));
DROP TABLE b22_refuse_down;
DROP TABLE dm_read_cursors;
DROP TRIGGER private_messages_safe_id;
DROP INDEX idx_pm_pair_recipient;
DROP INDEX idx_pm_pair_sender;
DROP INDEX ux_pm_sender_client;
ALTER TABLE private_messages DROP COLUMN client_id;
