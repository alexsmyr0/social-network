-- Group history is lossy to remove. With any group, membership, entry or group
-- notice present, restore a coordinated pre-upgrade backup instead.
CREATE TEMP TABLE b18_refuse_down(value INTEGER CHECK(value=1));
INSERT INTO b18_refuse_down SELECT CASE WHEN
  EXISTS(SELECT 1 FROM groups) OR EXISTS(SELECT 1 FROM group_memberships)
  OR EXISTS(SELECT 1 FROM group_invitations) OR EXISTS(SELECT 1 FROM group_join_requests)
  OR EXISTS(SELECT 1 FROM notifications WHERE type IN ('group_invitation','group_join_request'))
THEN 0 ELSE 1 END;
DROP TABLE b18_refuse_down;
CREATE TABLE notifications_prev (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('post_like','post_dislike','comment','comment_like','comment_dislike','follow_request')),
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
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
INSERT INTO notifications_prev(id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read)
  SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read FROM notifications;
INSERT INTO sqlite_sequence(name,seq) SELECT 'notifications_prev',0
  WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='notifications_prev');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='notifications'),0))
  WHERE name='notifications_prev';
DROP TABLE notifications;
ALTER TABLE notifications_prev RENAME TO notifications;
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX idx_notifications_unread ON notifications(recipient_id,is_read);
CREATE UNIQUE INDEX ux_notification_post ON notifications(recipient_id,actor_id,type,post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_comment ON notifications(recipient_id,actor_id,type,comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_follow ON notifications(recipient_id,follow_id) WHERE follow_id IS NOT NULL;
DROP TABLE group_join_requests;
DROP TABLE group_invitations;
DROP TABLE group_memberships;
DROP TABLE groups;
