INSERT INTO notifications (
  id,
  recipient_id,
  actor_id,
  type,
  post_id,
  comment_id,
  created_at,
  is_read
) VALUES
  (1, 1, 2, 'post_like', 1, NULL, '2026-04-02T12:20:00Z', 0),
  (2, 1, 3, 'post_like', 1, NULL, '2026-04-02T12:21:00Z', 0),
  (3, 2, 4, 'post_dislike', 2, NULL, '2026-04-02T12:22:00Z', 1),
  (4, 1, 6, 'comment', NULL, 1, '2026-04-02T12:23:00Z', 0),
  (5, 6, 2, 'comment_like', NULL, 1, '2026-04-02T12:24:00Z', 0),
  (6, 3, 4, 'comment_dislike', NULL, 3, '2026-04-02T12:25:00Z', 1),
  (7, 4, 1, 'post_like', 4, NULL, '2026-04-02T12:26:00Z', 0),
  (8, 5, 4, 'comment', NULL, 8, '2026-04-02T12:27:00Z', 0);
