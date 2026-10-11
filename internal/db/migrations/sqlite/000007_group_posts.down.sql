-- Group posts cannot be converted back to personal posts: removing the column
-- would discard their scope. With any group post present, restore a coordinated
-- pre-upgrade backup instead. With none, the column and its objects round-trip.
CREATE TEMP TABLE b19_refuse_down(value INTEGER CHECK(value=1));
INSERT INTO b19_refuse_down SELECT CASE WHEN EXISTS(SELECT 1 FROM posts WHERE group_id IS NOT NULL) THEN 0 ELSE 1 END;
DROP TABLE b19_refuse_down;
DROP TRIGGER group_post_audience_inert;
DROP TRIGGER group_post_scope_immutable;
DROP TRIGGER group_post_insert;
DROP INDEX idx_posts_group_feed;
ALTER TABLE posts DROP COLUMN group_id;
