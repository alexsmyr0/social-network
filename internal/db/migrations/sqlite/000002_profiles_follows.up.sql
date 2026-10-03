ALTER TABLE users ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (profile_visibility IN ('public', 'private'));
ALTER TABLE users ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1
  CHECK (profile_version BETWEEN 1 AND 9007199254740991);
ALTER TABLE users ADD COLUMN display_name_search TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_users_display_name ON users(display_name_search, id);

CREATE TABLE follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id BETWEEN 1 AND 9007199254740991),
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  accepted_at TEXT,
  UNIQUE (follower_id, followed_id),
  CHECK (follower_id <> followed_id),
  CHECK ((state = 'pending' AND accepted_at IS NULL) OR
         (state = 'accepted' AND accepted_at IS NOT NULL))
);
CREATE INDEX idx_follows_incoming ON follows(followed_id, state, created_at, id);
CREATE INDEX idx_follows_outgoing ON follows(follower_id, state, followed_id);
