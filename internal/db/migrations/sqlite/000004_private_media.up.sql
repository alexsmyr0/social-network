CREATE TABLE media_objects (
 id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
 source_key TEXT NOT NULL UNIQUE,
 object_key TEXT NOT NULL UNIQUE CHECK(length(object_key)>0 AND instr(object_key,'/')=0 AND instr(object_key,'\')=0),
 legacy_url TEXT UNIQUE,
 mime_type TEXT CHECK(mime_type IN('image/jpeg','image/png','image/gif')),
 byte_count INTEGER CHECK(byte_count>=0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','ready','missing')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 CHECK(state<>'ready' OR (mime_type IS NOT NULL AND byte_count IS NOT NULL))
);
CREATE TABLE media_links (
 id INTEGER PRIMARY KEY,
 media_id INTEGER NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
 avatar_user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 post_id INTEGER UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
 comment_id INTEGER UNIQUE REFERENCES comments(id) ON DELETE CASCADE,
 message_id INTEGER UNIQUE REFERENCES private_messages(id) ON DELETE CASCADE,
 CHECK((avatar_user_id IS NOT NULL)+(post_id IS NOT NULL)+(comment_id IS NOT NULL)+(message_id IS NOT NULL)=1)
);
CREATE INDEX idx_media_links_object ON media_links(media_id);
CREATE TABLE media_pending (
 media_id INTEGER PRIMARY KEY REFERENCES media_objects(id) ON DELETE CASCADE,
 uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('content','dm')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 CHECK((kind='content' AND recipient_id IS NULL) OR (kind='dm' AND recipient_id IS NOT NULL AND recipient_id<>uploader_id))
);
CREATE TRIGGER media_posts_insert AFTER INSERT ON posts BEGIN
 DELETE FROM media_links WHERE post_id=NEW.id;
 INSERT INTO media_links(media_id,post_id) SELECT id,NEW.id FROM media_objects
 WHERE '/api/v1/media/'||id=NEW.image_url OR legacy_url=NEW.image_url;
END;
CREATE TRIGGER media_posts_update AFTER UPDATE OF image_url ON posts BEGIN
 DELETE FROM media_links WHERE post_id=NEW.id;
 INSERT INTO media_links(media_id,post_id) SELECT id,NEW.id FROM media_objects
 WHERE '/api/v1/media/'||id=NEW.image_url OR legacy_url=NEW.image_url;
END;
CREATE TRIGGER media_comments_insert AFTER INSERT ON comments BEGIN
 DELETE FROM media_links WHERE comment_id=NEW.id;
 INSERT INTO media_links(media_id,comment_id) SELECT id,NEW.id FROM media_objects
 WHERE '/api/v1/media/'||id=NEW.image_url OR legacy_url=NEW.image_url;
END;
CREATE TRIGGER media_comments_update AFTER UPDATE OF image_url ON comments BEGIN
 DELETE FROM media_links WHERE comment_id=NEW.id;
 INSERT INTO media_links(media_id,comment_id) SELECT id,NEW.id FROM media_objects
 WHERE '/api/v1/media/'||id=NEW.image_url OR legacy_url=NEW.image_url;
END;
CREATE TRIGGER media_private_messages_insert AFTER INSERT ON private_messages BEGIN
 DELETE FROM media_links WHERE message_id=NEW.id;
 INSERT INTO media_links(media_id,message_id) SELECT id,NEW.id FROM media_objects
 WHERE '/api/v1/media/'||id=NEW.image_path OR legacy_url=NEW.image_path;
END;
CREATE TRIGGER media_private_messages_update AFTER UPDATE OF image_path ON private_messages BEGIN
 DELETE FROM media_links WHERE message_id=NEW.id;
 INSERT INTO media_links(media_id,message_id) SELECT id,NEW.id FROM media_objects
 WHERE '/api/v1/media/'||id=NEW.image_path OR legacy_url=NEW.image_path;
END;
CREATE TRIGGER media_users_insert AFTER INSERT ON users BEGIN
 DELETE FROM media_links WHERE avatar_user_id=NEW.id;
 INSERT INTO media_links(media_id,avatar_user_id) SELECT id,NEW.id FROM media_objects WHERE object_key=NEW.avatar_key;
END;
CREATE TRIGGER media_users_update AFTER UPDATE OF avatar_key ON users BEGIN
 DELETE FROM media_links WHERE avatar_user_id=NEW.id;
 INSERT INTO media_links(media_id,avatar_user_id) SELECT id,NEW.id FROM media_objects WHERE object_key=NEW.avatar_key;
END;
