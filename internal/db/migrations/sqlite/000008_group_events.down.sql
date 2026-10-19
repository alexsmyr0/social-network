-- Refuse a lossy downgrade; restore coordinated backup instead.
CREATE TEMP TABLE b21_refuse_down(value INTEGER NOT NULL CHECK(value=1));
INSERT INTO b21_refuse_down SELECT NOT(EXISTS(SELECT 1 FROM group_events) OR EXISTS(SELECT 1 FROM group_event_responses) OR EXISTS(SELECT 1 FROM notifications WHERE event_id IS NOT NULL));
DROP TABLE b21_refuse_down;
CREATE TABLE notifications_prev (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('post_like','post_dislike','comment','comment_like','comment_dislike','follow_request','group_invitation','group_join_request')),
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  follow_id INTEGER CHECK (follow_id BETWEEN 1 AND 9007199254740991),
  follow_state TEXT,
  group_id INTEGER REFERENCES groups(id) ON DELETE RESTRICT,
  group_entry_id INTEGER CHECK (group_entry_id BETWEEN 1 AND 9007199254740991),
  group_state TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  CHECK (
    (type = 'follow_request' AND follow_id IS NOT NULL AND post_id IS NULL AND comment_id IS NULL
      AND follow_state IS NOT NULL AND follow_state IN ('pending','accepted','declined','cancelled','unfollowed')
      AND group_id IS NULL AND group_entry_id IS NULL AND group_state IS NULL) OR
    (type IN ('group_invitation','group_join_request') AND group_id IS NOT NULL AND group_entry_id IS NOT NULL
      AND group_state IS NOT NULL AND post_id IS NULL AND comment_id IS NULL AND follow_id IS NULL AND follow_state IS NULL
      AND ((type = 'group_invitation' AND group_state IN ('pending','accepted','refused','cancelled','superseded'))
        OR (type = 'group_join_request' AND group_state IN ('pending','accepted','refused','superseded')))) OR
    (type NOT IN ('follow_request','group_invitation','group_join_request') AND follow_id IS NULL AND follow_state IS NULL
      AND group_id IS NULL AND group_entry_id IS NULL AND group_state IS NULL
      AND ((post_id IS NOT NULL AND comment_id IS NULL) OR (post_id IS NULL AND comment_id IS NOT NULL)))
  )
);
INSERT INTO notifications_prev(id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read) SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read FROM notifications;
INSERT INTO sqlite_sequence(name,seq) SELECT 'notifications_prev',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='notifications_prev');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='notifications'),0)) WHERE name='notifications_prev';
CREATE TEMP TABLE notification_copy_check(valid INTEGER NOT NULL CHECK(valid=1));
INSERT INTO notification_copy_check SELECT
 (SELECT COUNT(*) FROM notifications)=(SELECT COUNT(*) FROM notifications_prev)
 AND NOT EXISTS(SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read FROM notifications EXCEPT SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read FROM notifications_prev)
 AND NOT EXISTS(SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read FROM notifications_prev EXCEPT SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read FROM notifications);
DROP TABLE notification_copy_check;
DROP TABLE notifications;
ALTER TABLE notifications_prev RENAME TO notifications;
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX idx_notifications_unread ON notifications(recipient_id,is_read);
CREATE UNIQUE INDEX ux_notification_post ON notifications(recipient_id,actor_id,type,post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_comment ON notifications(recipient_id,actor_id,type,comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_follow ON notifications(recipient_id,follow_id) WHERE follow_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_group ON notifications(recipient_id,type,group_entry_id) WHERE group_entry_id IS NOT NULL;
DROP TABLE group_event_responses;
DROP TABLE group_events;
