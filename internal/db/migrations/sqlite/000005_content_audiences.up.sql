-- B15: connection-pinned rebuild; startup owns foreign keys and transaction.
CREATE TABLE posts_b15 (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT,
 image_url TEXT,
 body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'published' CHECK(status IN('draft','published','archived')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 audience TEXT NOT NULL DEFAULT 'public' CHECK(audience IN('public','followers','selected')),
 content_version INTEGER NOT NULL DEFAULT 1 CHECK(content_version BETWEEN 1 AND 9007199254740991),
 CHECK(status='draft' OR length(body)>0 OR image_url IS NOT NULL)
);
INSERT INTO posts_b15(id,author_id,title,image_url,body,status,created_at,updated_at)
 SELECT id,author_id,title,image_url,body,status,created_at,updated_at FROM posts;
-- B15 SWAP
DROP TABLE posts;
ALTER TABLE posts_b15 RENAME TO posts;
ALTER TABLE comments ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1 CHECK(content_version BETWEEN 1 AND 9007199254740991);
CREATE INDEX idx_posts_feed ON posts(status,created_at DESC,id DESC);
CREATE INDEX idx_posts_author_feed ON posts(author_id,status,created_at DESC,id DESC);
CREATE TABLE post_selected_followers (
 post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 follow_id INTEGER NOT NULL REFERENCES follows(id) ON DELETE CASCADE,
 PRIMARY KEY(post_id,follow_id)
);
CREATE INDEX idx_post_selected_follow ON post_selected_followers(follow_id,post_id);
CREATE TRIGGER selected_grant_insert BEFORE INSERT ON post_selected_followers BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM posts p JOIN follows f ON f.id=NEW.follow_id AND f.followed_id=p.author_id AND f.state='accepted'
 JOIN users a ON a.id=p.author_id AND a.is_active=1 JOIN users v ON v.id=f.follower_id AND v.is_active=1
 WHERE p.id=NEW.post_id AND p.audience='selected' AND f.follower_id<>p.author_id
 ) THEN RAISE(ABORT,'invalid selected grant') END;
END;
CREATE TRIGGER selected_grant_update BEFORE UPDATE ON post_selected_followers BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM posts p JOIN follows f ON f.id=NEW.follow_id AND f.followed_id=p.author_id AND f.state='accepted'
 JOIN users a ON a.id=p.author_id AND a.is_active=1 JOIN users v ON v.id=f.follower_id AND v.is_active=1
 WHERE p.id=NEW.post_id AND p.audience='selected' AND f.follower_id<>p.author_id
 ) THEN RAISE(ABORT,'invalid selected grant') END;
END;
-- Also protect direct relationship deletion: overflow aborts the entire transition.
CREATE TRIGGER selected_follow_delete BEFORE DELETE ON follows BEGIN
 UPDATE posts SET content_version=content_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE id IN(SELECT post_id FROM post_selected_followers WHERE follow_id=OLD.id);
END;
CREATE TRIGGER selected_post_audience BEFORE UPDATE OF audience,author_id ON posts
 WHEN EXISTS(SELECT 1 FROM post_selected_followers WHERE post_id=OLD.id)
 AND (NEW.audience<>'selected' OR NEW.author_id<>OLD.author_id) BEGIN
 SELECT RAISE(ABORT,'clear selected grants before changing audience');
END;
CREATE TRIGGER selected_follow_identity BEFORE UPDATE OF follower_id,followed_id,state ON follows
 WHEN EXISTS(SELECT 1 FROM post_selected_followers WHERE follow_id=OLD.id)
 AND (NEW.follower_id<>OLD.follower_id OR NEW.followed_id<>OLD.followed_id OR NEW.state<>'accepted') BEGIN
 SELECT RAISE(ABORT,'cannot invalidate selected follow identity');
END;
