-- SN-B03: initial social-network schema. This numbered migration is the
-- production schema authority. Existing unversioned forum databases are
-- rejected before this file runs; they are never upgraded in place.

-- ===============================================================
-- Forum Database Schema (SQLite)
-- ===============================================================
-- Tables:
--   users            → registered members
--   categories       → post grouping
--   posts            → user-created threads
--   comments         → nested replies
--   post_categories  → M:N relation posts ↔ categories
--   reactions        → likes/dislikes on posts or comments
--   sessions         → login tracking with expiration
--   notifications    → post/comment activity aimed at a user
--   private_messages → direct messages between two users
--
-- Notes:
--   - All timestamps use UTC via strftime('%Y-%m-%dT%H:%M:%SZ','now')
--   - updated_at fields are updated by application logic (no triggers)
--   - Foreign keys enforce cascades for consistent cleanup
-- ===============================================================


-- ===============================================================
-- USERS
-- ===============================================================
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 30),
  email            TEXT NOT NULL COLLATE NOCASE UNIQUE
                   CHECK (instr(email, '@') > 1 AND email COLLATE BINARY = lower(email)),
  password_hash    TEXT NOT NULL CHECK (length(password_hash) > 0),
  age              INTEGER NOT NULL DEFAULT 0,
  gender           TEXT NOT NULL DEFAULT '',
  first_name       TEXT NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 100),
  last_name        TEXT NOT NULL CHECK (length(trim(last_name)) BETWEEN 1 AND 100),
  date_of_birth    TEXT NOT NULL CHECK (
                     date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                   ),
  nickname         TEXT DEFAULT NULL CHECK (nickname IS NULL OR length(nickname) <= 30),
  about_me         TEXT DEFAULT NULL CHECK (about_me IS NULL OR length(about_me) <= 1000),
  avatar_key       TEXT DEFAULT NULL UNIQUE,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  session_version  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ===============================================================
-- CATEGORIES
-- ===============================================================
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);


-- ===============================================================
-- POSTS
-- ===============================================================
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id   INTEGER NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) > 0),
  image_url   TEXT,
  body        TEXT NOT NULL CHECK ((length(body) > 0) OR image_url IS NOT NULL),
  status      TEXT NOT NULL DEFAULT 'published'
               CHECK (status IN ('draft','published','archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);


-- ===============================================================
-- COMMENTS (nested)
-- ===============================================================
CREATE TABLE IF NOT EXISTS comments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id            INTEGER NOT NULL,
  user_id            INTEGER NOT NULL,
  parent_comment_id  INTEGER,
  body               TEXT NOT NULL CHECK ((length(body) > 0) OR image_url IS NOT NULL),
  image_url          TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);


-- ===============================================================
-- POST ↔ CATEGORY RELATION (M:N)
-- ===============================================================
CREATE TABLE IF NOT EXISTS post_categories (
  post_id     INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, category_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- ===============================================================
-- SESSIONS
-- ===============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT DEFAULT NULL,
  revoked_at TEXT DEFAULT NULL,
  ip          TEXT,
  user_agent  TEXT CHECK (length(user_agent) <= 512),
  is_valid    INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


-- ===============================================================
-- REACTIONS (post or comment)
-- ===============================================================
CREATE TABLE IF NOT EXISTS reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  post_id     INTEGER,
  comment_id  INTEGER,
  value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((post_id IS NOT NULL) != (comment_id IS NOT NULL)),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id)    REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

-- ===============================================================
-- NOTIFICATIONS
-- ===============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id  INTEGER NOT NULL,
  actor_id      INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('post_like','post_dislike','comment','comment_like','comment_dislike')),
  post_id       INTEGER,
  comment_id    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_read       INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),

  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,

   -- Prevent invalid target
  CHECK (
    (post_id IS NOT NULL AND comment_id IS NULL) OR
    (post_id IS NULL AND comment_id IS NOT NULL)
  )
);

-- ===============================================================
-- PRIVATE MESSAGES
-- ===============================================================
CREATE TABLE IF NOT EXISTS private_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL,
  recipient_id  INTEGER NOT NULL,
  body          TEXT NOT NULL,
  image_path    TEXT DEFAULT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (sender_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (sender_id <> recipient_id),
  -- A message must carry text OR an image attachment (image-only DMs are
  -- allowed, matching the posts/comments image-only pattern).
  CHECK ((length(trim(body)) > 0) OR image_path IS NOT NULL)
);

-- ===============================================================
-- INDEXES
-- ===============================================================

-- Posts
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(author_id);

-- Comments
CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_user    ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_comment_id);

-- Post ↔ Categories
CREATE INDEX IF NOT EXISTS idx_post_categories_category
  ON post_categories(category_id);

-- Reactions
CREATE UNIQUE INDEX IF NOT EXISTS ux_react_user_post
  ON reactions(user_id, post_id)
  WHERE post_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_react_user_comment
  ON reactions(user_id, comment_id)
  WHERE comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reactions_post
  ON reactions(post_id);

CREATE INDEX IF NOT EXISTS idx_reactions_comment
  ON reactions(comment_id);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_id);

-- Users: email's column-level NOCASE uniqueness guards case variants.

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(recipient_id, is_read);

-- Private Messages
CREATE INDEX IF NOT EXISTS idx_pm_sender
  ON private_messages(sender_id, recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pm_recipient
  ON private_messages(recipient_id, sender_id, created_at DESC);

  -- ===============================================================
-- NOTIFICATION UNIQUENESS (ANTI-SPAM)
-- ===============================================================

-- One notification per actor per post per type
CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_post
  ON notifications(actor_id, recipient_id, post_id, type)
  WHERE post_id IS NOT NULL;

-- One notification per actor per comment per type
CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_comment
  ON notifications(actor_id, recipient_id, comment_id, type)
  WHERE comment_id IS NOT NULL;
