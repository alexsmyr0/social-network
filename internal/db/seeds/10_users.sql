INSERT INTO users (
  id,
  username,
  email,
  password_hash,
  age,
  gender,
  first_name,
  last_name,
  is_active,
  session_version,
  created_at,
  updated_at
) VALUES
  (1, 'alexriver', 'alex@example.com', '$2a$10$iI1JCD3ZF63jJP5mgmyxs.miF//77bBjza2vfRH.m/k8NM0Ah5CNO', 29, 'male', 'Alex', 'River', 1, 0, '2026-04-01T08:00:00Z', '2026-04-01T08:00:00Z'),
  (2, 'mariako', 'maria@example.com', '$2a$10$iI1JCD3ZF63jJP5mgmyxs.miF//77bBjza2vfRH.m/k8NM0Ah5CNO', 27, 'female', 'Maria', 'Kosta', 1, 0, '2026-04-01T08:05:00Z', '2026-04-01T08:05:00Z'),
  (3, 'samgreen', 'sam@example.com', '$2a$10$iI1JCD3ZF63jJP5mgmyxs.miF//77bBjza2vfRH.m/k8NM0Ah5CNO', 31, 'nonbinary', 'Sam', 'Green', 1, 0, '2026-04-01T08:10:00Z', '2026-04-01T08:10:00Z'),
  (4, 'nina.dev', 'nina@example.com', '$2a$10$iI1JCD3ZF63jJP5mgmyxs.miF//77bBjza2vfRH.m/k8NM0Ah5CNO', 24, 'female', 'Nina', 'Dev', 1, 0, '2026-04-01T08:15:00Z', '2026-04-01T08:15:00Z'),
  (5, 'theo_s', 'theo@example.com', '$2a$10$iI1JCD3ZF63jJP5mgmyxs.miF//77bBjza2vfRH.m/k8NM0Ah5CNO', 35, 'male', 'Theo', 'Stone', 1, 0, '2026-04-01T08:20:00Z', '2026-04-01T08:20:00Z'),
  (6, 'jade99', 'jade@example.com', '$2a$10$iI1JCD3ZF63jJP5mgmyxs.miF//77bBjza2vfRH.m/k8NM0Ah5CNO', 22, 'female', 'Jade', 'Norris', 1, 0, '2026-04-01T08:25:00Z', '2026-04-01T08:25:00Z'),
  (7, 'tester', 'tester@example.com', '$2a$10$s.mBn0sxKLdnUDGrwDpAEuc5z/jU8EJTf67PBFh3eUGVn3rlim6mC', 25, 'nonbinary', 'Test', 'User', 1, 0, '2026-04-28T00:00:00Z', '2026-04-28T00:00:00Z');
