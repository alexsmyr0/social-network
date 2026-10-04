-- Notification history cannot be represented by version 2. Restore a coordinated
-- pre-upgrade backup instead of silently deleting recipient history.
CREATE TABLE notification_downgrade_requires_backup (valid INTEGER CHECK (valid = 1));
INSERT INTO notification_downgrade_requires_backup VALUES (0);
