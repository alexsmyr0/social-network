-- Manual rollback only. Normal startup calls Up; it never drops data.
DROP TABLE IF EXISTS private_messages;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS post_categories;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
