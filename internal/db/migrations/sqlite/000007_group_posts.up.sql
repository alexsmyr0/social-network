-- B19: optional group scope for posts. Adding a nullable column rebuilds nothing:
-- every existing post keeps its ID, author, status, audience, version, times,
-- categories, attachments and selections, and stays personal (group_id NULL).
-- Comments, reactions and media inherit group scope through their parent post.
ALTER TABLE posts ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE RESTRICT;
CREATE INDEX idx_posts_group_feed ON posts(group_id,status,created_at DESC,id DESC) WHERE group_id IS NOT NULL;

-- Group posts store the inert audience 'public': access is decided by current
-- membership, never by a personal audience or its selection grants. A post can
-- only be created by a current, active member.
CREATE TRIGGER group_post_insert BEFORE INSERT ON posts WHEN NEW.group_id IS NOT NULL BEGIN
  SELECT CASE
    WHEN NEW.audience<>'public' THEN RAISE(ABORT,'group posts store the inert public audience')
    WHEN NOT EXISTS (SELECT 1 FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1
      WHERE gm.group_id=NEW.group_id AND gm.user_id=NEW.author_id)
      THEN RAISE(ABORT,'group post author must be a current member')
  END;
END;
-- Scope is create-only: no personal-to-group, group-to-personal or group-to-group move.
CREATE TRIGGER group_post_scope_immutable BEFORE UPDATE OF group_id ON posts
WHEN NEW.group_id IS NOT OLD.group_id BEGIN
  SELECT RAISE(ABORT,'post group scope is immutable');
END;
CREATE TRIGGER group_post_audience_inert BEFORE UPDATE OF audience ON posts
WHEN NEW.group_id IS NOT NULL AND NEW.audience<>'public' BEGIN
  SELECT RAISE(ABORT,'group posts store the inert public audience');
END;
