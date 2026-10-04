-- No table references notifications. Rebuild it without disabling foreign keys.
CREATE TABLE notifications_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('post_like','post_dislike','comment','comment_like','comment_dislike','follow_request')),
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  -- Historical identity survives removal; deliberately not a follows foreign key.
  follow_id INTEGER CHECK (follow_id BETWEEN 1 AND 9007199254740991),
  follow_state TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  CHECK (
    (type = 'follow_request' AND follow_id IS NOT NULL AND post_id IS NULL AND comment_id IS NULL
      AND follow_state IS NOT NULL AND follow_state IN ('pending','accepted','declined','cancelled','unfollowed')) OR
    (type <> 'follow_request' AND follow_id IS NULL AND follow_state IS NULL
      AND ((post_id IS NOT NULL AND comment_id IS NULL) OR (post_id IS NULL AND comment_id IS NOT NULL)))
  )
);
INSERT INTO notifications_next(id,recipient_id,actor_id,type,post_id,comment_id,created_at,is_read)
  SELECT id,recipient_id,actor_id,type,post_id,comment_id,created_at,is_read FROM notifications;
-- Preserve allocation even when the highest historical row has been deleted.
INSERT INTO sqlite_sequence(name,seq) SELECT 'notifications_next',0
  WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='notifications_next');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='notifications'),0))
  WHERE name='notifications_next';
-- Fail the migration before dropping the source if copying lost or changed data.
CREATE TABLE notification_copy_check (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO notification_copy_check SELECT
  (SELECT COUNT(*) FROM notifications) = (SELECT COUNT(*) FROM notifications_next)
  AND NOT EXISTS (
    SELECT id,recipient_id,actor_id,type,post_id,comment_id,created_at,is_read FROM notifications
    EXCEPT SELECT id,recipient_id,actor_id,type,post_id,comment_id,created_at,is_read FROM notifications_next
  );
DROP TABLE notification_copy_check;
DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX idx_notifications_unread ON notifications(recipient_id,is_read);
CREATE UNIQUE INDEX ux_notification_post ON notifications(recipient_id,actor_id,type,post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_comment ON notifications(recipient_id,actor_id,type,comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_follow ON notifications(recipient_id,follow_id) WHERE follow_id IS NOT NULL;
INSERT INTO notifications(recipient_id,actor_id,type,follow_id,follow_state,created_at)
  SELECT followed_id,follower_id,'follow_request',id,'pending',created_at FROM follows WHERE state='pending'
  ORDER BY created_at,id;
