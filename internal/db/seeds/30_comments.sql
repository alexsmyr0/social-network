INSERT INTO comments (
  id,
  post_id,
  user_id,
  parent_comment_id,
  body,
  image_url,
  created_at,
  updated_at
) VALUES
  (1, 1, 6, NULL, 'This should be the first comment people see on the QA post.', NULL, '2026-04-02T11:00:00Z', '2026-04-02T11:00:00Z'),
  (2, 1, 2, 1, 'Replying here makes sure nested comment rendering can be checked.', NULL, '2026-04-02T11:05:00Z', '2026-04-02T11:05:00Z'),
  (3, 2, 3, NULL, 'The routing note about middleware order is useful.', NULL, '2026-04-02T11:10:00Z', '2026-04-02T11:10:00Z'),
  (4, 2, 1, 3, 'Agreed. This is the reply used to test threaded comments.', NULL, '2026-04-02T11:15:00Z', '2026-04-02T11:15:00Z'),
  (5, 3, 5, NULL, 'Websocket test coverage should include reconnect behavior later.', NULL, '2026-04-02T11:20:00Z', '2026-04-02T11:20:00Z'),
  (6, 3, 2, NULL, 'This second root comment helps verify ordering on post detail.', NULL, '2026-04-02T11:25:00Z', '2026-04-02T11:25:00Z'),
  (7, 4, 1, NULL, 'Persistent shell layout still needs a few visual checks.', NULL, '2026-04-02T11:30:00Z', '2026-04-02T11:30:00Z'),
  (8, 5, 4, NULL, 'A non-technical thread is useful for smoke testing feed variety.', NULL, '2026-04-02T11:35:00Z', '2026-04-02T11:35:00Z'),
  (9, 1, 3, NULL, 'Adding a second top-level comment on post one broadens coverage.', NULL, '2026-04-02T11:40:00Z', '2026-04-02T11:40:00Z'),
  (10, 6, 2, NULL, 'This comment exists so the newest published post has activity too.', NULL, '2026-04-02T11:45:00Z', '2026-04-02T11:45:00Z');
