-- Refuse a lossy downgrade; restore a coordinated backup instead. Any stored
-- message is data. Without messages every cursor is still 0, so an untouched
-- upgrade round-trips: re-upgrading recreates identical cursors.
CREATE TEMP TABLE b23_refuse_down(value INTEGER NOT NULL CHECK(value=1));
INSERT INTO b23_refuse_down SELECT NOT(EXISTS(SELECT 1 FROM group_messages) OR EXISTS(SELECT 1 FROM group_read_cursors WHERE through_id<>0));
DROP TABLE b23_refuse_down;
DROP TRIGGER group_membership_cursor;
DROP TRIGGER group_read_cursor_monotonic;
DROP TABLE group_read_cursors;
DROP INDEX idx_group_messages_room;
DROP TABLE group_messages;
