-- Reset only QA-owned data.
-- Categories are bootstrap data and are intentionally preserved.
DELETE FROM sessions;
DELETE FROM notifications;
DELETE FROM reactions;
DELETE FROM comments;
DELETE FROM post_categories;
DELETE FROM posts;
DELETE FROM users;

DELETE FROM sqlite_sequence
WHERE name IN (
  'sessions',
  'notifications',
  'reactions',
  'comments',
  'posts',
  'users'
);
