-- B22: DM retry nonce and persisted read cursors. Additive only: existing
-- messages, IDs, bodies, image associations and media rows are not rewritten.
ALTER TABLE private_messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX ux_pm_sender_client ON private_messages(sender_id,client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_pm_pair_sender ON private_messages(sender_id,recipient_id,id);
CREATE INDEX idx_pm_pair_recipient ON private_messages(recipient_id,sender_id,id);
-- Message IDs stay inside the safe-integer range shared with every client.
CREATE TRIGGER private_messages_safe_id AFTER INSERT ON private_messages WHEN NEW.id>9007199254740991 BEGIN
 SELECT RAISE(ABORT,'message id exceeds safe range');
END;
-- through_id is a historical high-water mark, deliberately not a foreign key.
CREATE TABLE dm_read_cursors (
 viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 other_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 through_id INTEGER NOT NULL DEFAULT 0 CHECK(through_id BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(viewer_id,other_id),
 CHECK(viewer_id<>other_id)
);
-- Bootstrap both directions of every existing pair at the pair's latest message,
-- so browser-only legacy unread state is not invented as a server backlog.
INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)
 SELECT viewer_id,other_id,MAX(id) FROM (
  SELECT sender_id AS viewer_id,recipient_id AS other_id,id FROM private_messages
  UNION ALL
  SELECT recipient_id AS viewer_id,sender_id AS other_id,id FROM private_messages
 ) GROUP BY viewer_id,other_id;
