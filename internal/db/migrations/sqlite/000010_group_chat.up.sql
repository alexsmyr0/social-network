-- B23: one persisted chat room per group, plus per-membership read cursors.
-- Additive only: no existing table is rebuilt and no message, notice or media row
-- is touched. A room exists for every group by construction (its messages carry
-- the group ID), so groups from earlier phases need no backfill row.
CREATE TABLE group_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9007199254740991),
 group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
 sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 -- Historical generation of the sender, deliberately not a foreign key: leaving
 -- deletes the membership while the message stays.
 sender_membership_id INTEGER NOT NULL CHECK(sender_membership_id BETWEEN 1 AND 9007199254740991),
 -- Writers always supply a lowercase UUID v4; NULL exists only so approved
 -- fixtures can seed pre-nonce history. Nonces are unique per sender across rooms.
 client_id TEXT CHECK(client_id IS NULL OR length(client_id)=36),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 UNIQUE(sender_id,client_id)
);
CREATE INDEX idx_group_messages_room ON group_messages(group_id,id);

-- A cursor belongs to a membership generation. Departure cascades the cursor
-- only; contributions stay.
CREATE TABLE group_read_cursors (
 membership_id INTEGER PRIMARY KEY REFERENCES group_memberships(id) ON DELETE CASCADE,
 through_id INTEGER NOT NULL DEFAULT 0 CHECK(through_id BETWEEN 0 AND 9007199254740991)
);
-- Cursors never move backwards, however they are written.
CREATE TRIGGER group_read_cursor_monotonic BEFORE UPDATE OF through_id ON group_read_cursors
WHEN NEW.through_id<OLD.through_id BEGIN
 SELECT RAISE(ABORT,'read cursors only advance');
END;
-- Every admission, including the creator row written with a new group, starts its
-- cursor at the room's current latest message, in the admission transaction and
-- before any later message can exist. History stays readable; only the backlog is
-- not counted as unread.
CREATE TRIGGER group_membership_cursor AFTER INSERT ON group_memberships BEGIN
 INSERT INTO group_read_cursors(membership_id,through_id)
 VALUES(NEW.id,COALESCE((SELECT MAX(id) FROM group_messages WHERE group_id=NEW.group_id),0));
END;
-- No group message exists yet, so every current membership starts at 0 (the room's
-- current latest ID).
INSERT INTO group_read_cursors(membership_id,through_id) SELECT id,0 FROM group_memberships;
