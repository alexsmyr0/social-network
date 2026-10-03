-- Operator-only rollback: back up the database/media before discarding relationships.
DROP TABLE follows;
DROP INDEX idx_users_display_name;
ALTER TABLE users DROP COLUMN display_name_search;
ALTER TABLE users DROP COLUMN profile_version;
ALTER TABLE users DROP COLUMN profile_visibility;
