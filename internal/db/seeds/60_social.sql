-- Social-network sample data on top of the forum seed users (1-7).
-- Everyone signs in with password123, except tester@example.com (password).
-- Maria (2) and Nina (4) are private; the others are public.
-- Rows that other rows point at are found by natural keys, so only users,
-- posts, comments and notifications use the fixed IDs the reset restarts.

UPDATE users SET profile_visibility = 'private' WHERE id IN (2, 4);
UPDATE users SET nickname = 'alex', about_me = 'Trail runner and weekend hiker. Say hi! 👋' WHERE id = 1;
UPDATE users SET about_me = 'Painter. Private profile: follow me to see my studio notes.' WHERE id = 2;
UPDATE users SET nickname = 'samg' WHERE id = 3;

-- Accepted follows, then pending requests to the private profiles.
INSERT INTO follows (follower_id, followed_id, state, created_at, accepted_at) VALUES
  (1, 2, 'accepted', '2026-10-20T09:00:00Z', '2026-10-20T09:05:00Z'),
  (2, 1, 'accepted', '2026-10-20T09:10:00Z', '2026-10-20T09:10:00Z'),
  (3, 1, 'accepted', '2026-10-20T09:20:00Z', '2026-10-20T09:20:00Z'),
  (1, 3, 'accepted', '2026-10-20T09:25:00Z', '2026-10-20T09:25:00Z'),
  (4, 1, 'accepted', '2026-10-20T09:30:00Z', '2026-10-20T09:30:00Z'),
  (5, 2, 'accepted', '2026-10-20T09:40:00Z', '2026-10-20T09:45:00Z'),
  (6, 3, 'accepted', '2026-10-20T09:50:00Z', '2026-10-20T09:50:00Z'),
  (7, 1, 'accepted', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z'),
  (7, 3, 'accepted', '2026-10-20T10:05:00Z', '2026-10-20T10:05:00Z'),
  (3, 2, 'pending', '2026-10-21T08:00:00Z', NULL),
  (6, 4, 'pending', '2026-10-21T08:10:00Z', NULL),
  (7, 2, 'pending', '2026-10-21T08:20:00Z', NULL);

-- Personal posts for each audience.
INSERT INTO posts (id, author_id, title, image_url, body, status, audience, created_at, updated_at) VALUES
  (9, 3, 'Trail map for Saturday', NULL, 'Public route notes: 14 km, about 600 m of climbing. 🥾', 'published', 'public', '2026-10-22T08:00:00Z', '2026-10-22T08:00:00Z'),
  (10, 2, 'Studio notes', NULL, 'Followers only: the new canvas series starts next week. 🎨', 'published', 'followers', '2026-10-22T09:00:00Z', '2026-10-22T09:00:00Z'),
  (11, 1, 'For Maria only', NULL, 'Selected followers: the surprise party is on Friday. 🤫', 'published', 'selected', '2026-10-22T10:00:00Z', '2026-10-22T10:00:00Z');

INSERT INTO post_selected_followers (post_id, follow_id)
  SELECT 11, id FROM follows WHERE follower_id = 2 AND followed_id = 1;

-- Groups. Creating a group also creates the creator's membership.
INSERT INTO groups (creator_id, title, description, title_search, created_at) VALUES
  (1, 'Weekend Hikers', 'Planning hikes around the city every weekend.', 'weekend hikers', '2026-10-23T08:00:00Z'),
  (4, 'Book Club', 'One book a month, one meetup a month.', 'book club', '2026-10-23T09:00:00Z');

INSERT INTO group_memberships (group_id, user_id, role, joined_at)
  SELECT g.id, m.user_id, 'member', m.joined_at
  FROM groups g
  JOIN (
    SELECT 'Weekend Hikers' AS title, 2 AS user_id, '2026-10-23T08:30:00Z' AS joined_at
    UNION ALL SELECT 'Weekend Hikers', 3, '2026-10-23T08:40:00Z'
    UNION ALL SELECT 'Weekend Hikers', 7, '2026-10-23T08:50:00Z'
    UNION ALL SELECT 'Book Club', 1, '2026-10-23T09:30:00Z'
  ) m ON m.title = g.title;

-- A pending invitation (Alex invites Theo) and a pending join request (Jade).
INSERT INTO group_invitations (group_id, inviter_id, invitee_id, created_at)
  SELECT id, 1, 5, '2026-10-24T08:00:00Z' FROM groups WHERE title = 'Weekend Hikers';
INSERT INTO group_join_requests (group_id, requester_id, created_at)
  SELECT id, 6, '2026-10-24T08:30:00Z' FROM groups WHERE title = 'Weekend Hikers';

-- Members-only group content.
INSERT INTO posts (id, author_id, title, image_url, body, status, audience, group_id, created_at, updated_at)
  SELECT 12, 3, 'Gear list', NULL, 'Members only: bring water, a headlamp and a warm layer.', 'published', 'public', id, '2026-10-24T09:00:00Z', '2026-10-24T09:00:00Z'
  FROM groups WHERE title = 'Weekend Hikers';
INSERT INTO comments (id, post_id, user_id, parent_comment_id, body, image_url, created_at, updated_at) VALUES
  (11, 12, 2, NULL, 'Adding sunscreen to the list ☀️', NULL, '2026-10-24T09:30:00Z', '2026-10-24T09:30:00Z');

-- Events with Going / Not going answers.
INSERT INTO group_events (group_id, creator_id, title, description, starts_at, created_at)
  SELECT id, 1, 'Sunrise hike', 'Meet at the north trailhead.', '2026-12-05T06:30:00Z', '2026-10-25T08:00:00Z'
  FROM groups WHERE title = 'Weekend Hikers';
INSERT INTO group_events (group_id, creator_id, title, description, starts_at, created_at)
  SELECT id, 4, 'November meetup', 'Discussing this month''s book over coffee.', '2026-11-20T18:00:00Z', '2026-10-25T09:00:00Z'
  FROM groups WHERE title = 'Book Club';

INSERT INTO group_event_responses (event_id, user_id, membership_id, choice, version, updated_at)
  SELECT e.id, gm.user_id, gm.id, r.choice, 1, '2026-10-25T10:00:00Z'
  FROM group_events e
  JOIN group_memberships gm ON gm.group_id = e.group_id
  JOIN (SELECT 2 AS user_id, 'going' AS choice UNION ALL SELECT 3, 'not_going') r ON r.user_id = gm.user_id
  WHERE e.title = 'Sunrise hike';

-- Private messages, with Alex's latest message from Maria unread.
INSERT INTO private_messages (sender_id, recipient_id, body, created_at) VALUES
  (2, 1, 'Did you see the trail map Sam posted? 🗺️', '2026-10-26T08:00:00Z'),
  (1, 2, 'Yes! Saturday works for me 👍', '2026-10-26T08:05:00Z'),
  (2, 1, 'Great, I''ll bring snacks 🍪', '2026-10-26T08:10:00Z'),
  (3, 1, 'Are you joining the sunrise hike?', '2026-10-26T09:00:00Z');

INSERT INTO dm_read_cursors (viewer_id, other_id, through_id)
  SELECT 1, 2, MIN(id) FROM private_messages WHERE sender_id = 2 AND recipient_id = 1;
INSERT INTO dm_read_cursors (viewer_id, other_id, through_id)
  SELECT 2, 1, MAX(id) FROM private_messages WHERE (sender_id = 1 AND recipient_id = 2) OR (sender_id = 2 AND recipient_id = 1);
INSERT INTO dm_read_cursors (viewer_id, other_id, through_id) VALUES (1, 3, 0);
INSERT INTO dm_read_cursors (viewer_id, other_id, through_id)
  SELECT 3, 1, MAX(id) FROM private_messages WHERE sender_id = 3 AND recipient_id = 1;

-- The Weekend Hikers room.
INSERT INTO group_messages (group_id, sender_id, sender_membership_id, client_id, body, created_at)
  SELECT gm.group_id, gm.user_id, gm.id, NULL, m.body, m.created_at
  FROM group_memberships gm
  JOIN groups g ON g.id = gm.group_id AND g.title = 'Weekend Hikers'
  JOIN (
    SELECT 1 AS user_id, 'Welcome to Weekend Hikers! 🏔️' AS body, '2026-10-26T10:00:00Z' AS created_at
    UNION ALL SELECT 2, 'Happy to be here 🙌', '2026-10-26T10:05:00Z'
    UNION ALL SELECT 3, 'Who''s in for Saturday?', '2026-10-26T10:10:00Z'
  ) m ON m.user_id = gm.user_id
  ORDER BY m.created_at;

-- Alex has read the whole room; Maria has read the first message.
UPDATE group_read_cursors
  SET through_id = (SELECT MAX(gmsg.id) FROM group_messages gmsg JOIN groups g ON g.id = gmsg.group_id WHERE g.title = 'Weekend Hikers')
  WHERE membership_id = (SELECT gm.id FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE g.title = 'Weekend Hikers' AND gm.user_id = 1);
UPDATE group_read_cursors
  SET through_id = (SELECT MIN(gmsg.id) FROM group_messages gmsg JOIN groups g ON g.id = gmsg.group_id WHERE g.title = 'Weekend Hikers')
  WHERE membership_id = (SELECT gm.id FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE g.title = 'Weekend Hikers' AND gm.user_id = 2);

-- Notifications for each pending request and each event.
INSERT INTO notifications (recipient_id, actor_id, type, follow_id, follow_state, created_at, is_read)
  SELECT followed_id, follower_id, 'follow_request', id, 'pending', created_at, 0
  FROM follows WHERE state = 'pending' ORDER BY created_at;

INSERT INTO notifications (recipient_id, actor_id, type, group_id, group_entry_id, group_state, created_at, is_read)
  SELECT invitee_id, inviter_id, 'group_invitation', group_id, id, 'pending', created_at, 0
  FROM group_invitations;

INSERT INTO notifications (recipient_id, actor_id, type, group_id, group_entry_id, group_state, created_at, is_read)
  SELECT g.creator_id, r.requester_id, 'group_join_request', r.group_id, r.id, 'pending', r.created_at, 0
  FROM group_join_requests r JOIN groups g ON g.id = r.group_id;

INSERT INTO notifications (recipient_id, actor_id, type, group_id, event_id, created_at, is_read)
  SELECT gm.user_id, e.creator_id, 'group_event', e.group_id, e.id, e.created_at, 0
  FROM group_events e JOIN group_memberships gm ON gm.group_id = e.group_id
  WHERE gm.user_id <> e.creator_id
  ORDER BY e.created_at, gm.user_id;
