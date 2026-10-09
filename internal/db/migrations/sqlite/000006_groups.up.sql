-- B18: groups, membership, invitations, join requests and their notices.
-- Only pending invitations/requests exist; resolution deletes the row and the
-- notice keeps the history. IDs come from AUTOINCREMENT and are never reused.
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  -- Unicode-lowercase search key maintained by the writer, like display_name_search.
  title_search TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_groups_feed ON groups(created_at DESC,id DESC);

CREATE TABLE group_memberships (
  -- The membership ID is the generation: a returned member gets a new ID.
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('creator','member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (group_id,user_id)
);
CREATE UNIQUE INDEX ux_group_creator ON group_memberships(group_id) WHERE role='creator';
CREATE INDEX idx_group_memberships_user ON group_memberships(user_id,group_id);

CREATE TABLE group_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (inviter_id <> invitee_id),
  UNIQUE (group_id,invitee_id,inviter_id)
);
CREATE INDEX idx_group_invitations_invitee ON group_invitations(invitee_id,created_at DESC,id DESC);
CREATE INDEX idx_group_invitations_inviter ON group_invitations(group_id,inviter_id);

CREATE TABLE group_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (group_id,requester_id)
);
CREATE INDEX idx_group_join_requests_group ON group_join_requests(group_id,created_at DESC,id DESC);

-- No writer can create a group without its creator membership.
CREATE TRIGGER group_creator_membership AFTER INSERT ON groups BEGIN
  INSERT INTO group_memberships(group_id,user_id,role,joined_at) VALUES (NEW.id,NEW.creator_id,'creator',NEW.created_at);
END;
-- Membership rows are insert/delete only; the creator row outlives every member action.
CREATE TRIGGER group_membership_immutable BEFORE UPDATE OF group_id,user_id,role ON group_memberships BEGIN
  SELECT RAISE(ABORT,'membership rows are insert or delete only');
END;
CREATE TRIGGER group_creator_retained BEFORE DELETE ON group_memberships
WHEN OLD.role='creator' AND EXISTS (SELECT 1 FROM groups WHERE id=OLD.group_id) BEGIN
  SELECT RAISE(ABORT,'creator membership is retained');
END;
-- Backstops for the transactional writers: admission resolves the person's other
-- pending entries; departure cancels the departing inviter's invitations.
CREATE TRIGGER group_admission_resolves AFTER INSERT ON group_memberships BEGIN
  DELETE FROM group_invitations WHERE group_id=NEW.group_id AND invitee_id=NEW.user_id;
  DELETE FROM group_join_requests WHERE group_id=NEW.group_id AND requester_id=NEW.user_id;
END;
CREATE TRIGGER group_departure_cancels AFTER DELETE ON group_memberships BEGIN
  DELETE FROM group_invitations WHERE group_id=OLD.group_id AND inviter_id=OLD.user_id;
END;
CREATE TRIGGER group_invitation_eligibility BEFORE INSERT ON group_invitations BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM group_memberships WHERE group_id=NEW.group_id AND user_id=NEW.inviter_id)
      THEN RAISE(ABORT,'inviter must be a current member')
    WHEN EXISTS (SELECT 1 FROM group_memberships WHERE group_id=NEW.group_id AND user_id=NEW.invitee_id)
      THEN RAISE(ABORT,'invitee is already a member')
  END;
END;
CREATE TRIGGER group_invitation_immutable BEFORE UPDATE ON group_invitations BEGIN
  SELECT RAISE(ABORT,'invitations are insert or delete only');
END;
CREATE TRIGGER group_request_eligibility BEFORE INSERT ON group_join_requests BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM group_memberships WHERE group_id=NEW.group_id AND user_id=NEW.requester_id)
      THEN RAISE(ABORT,'requester is already a member')
  END;
END;
CREATE TRIGGER group_request_immutable BEFORE UPDATE ON group_join_requests BEGIN
  SELECT RAISE(ABORT,'join requests are insert or delete only');
END;

-- No table references notifications. Rebuild it without disabling foreign keys.
-- group_entry_id is deliberately not a foreign key: resolved entries are deleted
-- and the notice keeps their historical identity and state.
CREATE TABLE notifications_b18 (
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
INSERT INTO notifications_b18(id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read)
  SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read FROM notifications;
-- Preserve allocation even when the highest historical row has been deleted.
INSERT INTO sqlite_sequence(name,seq) SELECT 'notifications_b18',0
  WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='notifications_b18');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='notifications'),0))
  WHERE name='notifications_b18';
-- Fail the migration before dropping the source if copying lost or changed data.
CREATE TABLE notification_copy_check (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO notification_copy_check SELECT
  (SELECT COUNT(*) FROM notifications) = (SELECT COUNT(*) FROM notifications_b18)
  AND NOT EXISTS (
    SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read FROM notifications
    EXCEPT SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read FROM notifications_b18
  )
  AND NOT EXISTS (
    SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read FROM notifications_b18
    EXCEPT SELECT id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read FROM notifications
  );
DROP TABLE notification_copy_check;
DROP TABLE notifications;
ALTER TABLE notifications_b18 RENAME TO notifications;
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX idx_notifications_unread ON notifications(recipient_id,is_read);
CREATE UNIQUE INDEX ux_notification_post ON notifications(recipient_id,actor_id,type,post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_comment ON notifications(recipient_id,actor_id,type,comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_follow ON notifications(recipient_id,follow_id) WHERE follow_id IS NOT NULL;
CREATE UNIQUE INDEX ux_notification_group ON notifications(recipient_id,type,group_entry_id) WHERE group_entry_id IS NOT NULL;
