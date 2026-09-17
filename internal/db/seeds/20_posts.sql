INSERT INTO posts (
  id,
  author_id,
  title,
  image_url,
  body,
  status,
  created_at,
  updated_at
) VALUES
  (1, 1, 'Welcome to the QA forum', NULL, 'This is the baseline announcement post used for QA runs.', 'published', '2026-04-02T09:00:00Z', '2026-04-02T09:00:00Z'),
  (2, 2, 'Go routing notes', NULL, 'Collected notes about router behavior, middleware order, and API versioning.', 'published', '2026-04-02T09:15:00Z', '2026-04-02T09:15:00Z'),
  (3, 3, 'Testing websocket ideas', NULL, 'A scratchpad for realtime feature expectations and edge cases.', 'published', '2026-04-02T09:30:00Z', '2026-04-02T09:30:00Z'),
  (4, 4, 'Frontend shell review', NULL, 'A post about SPA shell consistency across authenticated routes.', 'published', '2026-04-02T09:45:00Z', '2026-04-02T09:45:00Z'),
  (5, 5, 'Sports thread for demos', NULL, 'Used to verify categories and reactions on non-technical content.', 'published', '2026-04-02T10:00:00Z', '2026-04-02T10:00:00Z'),
  (6, 6, 'News roundup', NULL, 'Seed content for feed rendering, pagination, and author attribution.', 'published', '2026-04-02T10:15:00Z', '2026-04-02T10:15:00Z'),
  (7, 4, 'Draft: onboarding checklist', NULL, 'Internal draft content for save and resume workflows.', 'draft', '2026-04-02T10:30:00Z', '2026-04-02T10:30:00Z'),
  (8, 1, 'Draft: category cleanup ideas', NULL, 'Another draft entry so QA has more than one draft owner to inspect.', 'draft', '2026-04-02T10:45:00Z', '2026-04-02T10:45:00Z');
