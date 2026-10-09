# Phase 4 Data and Access Handoff — SN-B17

Prepared on `asmyrogl/B17` from merged main `e331ca0`, 2026-10-09. **Owner-approved handoff; documentation/fixture checks passed. No SQL, migration or runtime change executed.** Implements the already-approved [Phase 4 architecture](phase-4-decisions.md#approved-architecture-and-handoffs) through the [groups contract](groups-contract.md) and [fixture pack](fixtures/phase-4-contract.json). Preserve account, session, profile, follow, content, notification and [B13 private media](backend-content-media.md) behavior. No events, group chat, new moderator/transfer/deletion workflow, queue, socket, database, service or reset.

## Upgrade ownership and mappings

Latest embedded migration is 000005 (B15). Reserve **000006 / B18** for the four group tables and the notification rebuild, and **000007 / B19** for the optional post `group_id`. B19 must not need a future A17 suite to finish its backend gate; B18 must not edit posts. Confirm numbers at implementation time and never edit earlier migration files.

| Entity | Mapping / invariant |
|---|---|
| groups | New. `id AUTOINCREMENT`, `creator_id → users` (`ON DELETE RESTRICT`: accounts are deactivated, never deleted), `title TEXT NOT NULL CHECK length BETWEEN 1 AND 100`, `description TEXT NOT NULL CHECK length BETWEEN 1 AND 1000`, `title_search` (Go Unicode-lowercase key maintained by the writer, like `display_name_search`), `created_at`. Index `(created_at DESC,id DESC)`. No title uniqueness. |
| group_memberships | New. `id AUTOINCREMENT` (the membership generation), `group_id → groups`, `user_id → users`, `role IN ('creator','member')`, `joined_at`; `UNIQUE(group_id,user_id)`; partial `UNIQUE(group_id) WHERE role='creator'`; index `(user_id,group_id)`. Rows are insert/delete only (trigger rejects updates of group/user/role); the creator row cannot be deleted. An `AFTER INSERT ON groups` trigger inserts the creator membership, so no writer can create a group without it. |
| group_invitations | New. `id AUTOINCREMENT`, `group_id`, `inviter_id`, `invitee_id → users`, `created_at`; `CHECK inviter_id<>invitee_id`; `UNIQUE(group_id,invitee_id,inviter_id)`; indexes `(invitee_id,created_at DESC,id DESC)`, `(group_id,inviter_id)`. Only pending rows exist; resolution deletes the row. A `BEFORE INSERT` trigger requires a current-member inviter and non-member invitee. |
| group_join_requests | New. `id AUTOINCREMENT`, `group_id`, `requester_id → users`, `created_at`; `UNIQUE(group_id,requester_id)`; index `(group_id,created_at DESC,id DESC)`. Pending only. A `BEFORE INSERT` trigger rejects a current member. |
| notifications | Rebuild like B12 (no table references notifications, so no foreign-key disabling): add types `group_invitation`, `group_join_request`; nullable `group_id → groups`, nullable historical `group_entry_id` (deliberately **not** a foreign key, because resolved entries are deleted) and `group_state` (`pending`, `accepted`, `refused`, `cancelled`, `superseded`; invitations only, requests omit `cancelled`). CHECK: group types require group ID/entry/state and null post/comment/follow fields; existing types keep their exact targets. Unique `(recipient_id,type,group_entry_id) WHERE group_entry_id IS NOT NULL`. Preserve every ID, type, actor, recipient, target, read flag, time, `follow_id`/`follow_state`, the four existing indexes and `sqlite_sequence`; copy-check counts and bidirectional `EXCEPT` before dropping the source. |
| posts | **000007**: `ALTER TABLE posts ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE RESTRICT` (default NULL, which SQLite permits with enforcement on) — **no table rebuild**. Every existing post keeps its ID, author, status, audience, version, times, categories, attachments, selections and `NULL` group. Partial index `(group_id,status,created_at DESC,id DESC) WHERE group_id IS NOT NULL`; keep `idx_posts_feed` and `idx_posts_author_feed`. Triggers: group posts must store audience `public` (inert, never consulted) so personal selection triggers can never apply; `group_id` is immutable after insert (no personal-to-group conversion); insert requires the author's current membership. |
| comments, reactions, post_categories | Unchanged. Group scope is inherited through the parent post; no audience or group column. Departed users' rows stay stored. |
| media | Unchanged object/link/pending/source/state/bytes and the post/comment image triggers. Extend only the parent-post predicate. Departed authors' files stay referenced; the post-commit sweeper still deletes only unreferenced private bytes. |
| users / sessions / follows / profiles / avatars | No change. Membership grants content access, not profile fields or avatars. |

`AUTOINCREMENT` plus preserved `sqlite_sequence` guarantees group, membership, invitation and request IDs are never reused even after deleting the highest row. Seeds and test resets that `DELETE FROM users` (for example `internal/db/seeds/00_reset.sql`) must delete the group tables first; B18 owns that update.

Inactive accounts retain their rows. Reads and decisions treat an inactive participant as absent: no list entry, no count, no usable invitation from an inactive inviter, no notice with an inactive actor. Nothing is deleted on deactivation.

## Shared predicate and query shape

One shared function chooses the rule by post scope, never by OR-ing them:

`CASE WHEN p.group_id IS NULL THEN <personal contentPermission> ELSE <active viewer AND active author AND EXISTS current membership of viewer in p.group_id AND (published OR author is viewer)> END`.

Profile visibility, follows and personal audiences are not consulted for group posts; group membership is not consulted for personal posts. It is reused unchanged by detail, comments, reactions, attachments and feeds, and composed with profile permission for `/users/{id}/posts|comments`. Filter before counting, paging, aggregation and navigation. Group feed uses the partial index; home feed is the personal branch union the membership branch, ordered `(created_at DESC,id DESC)` in one read snapshot. B18 exports `CanViewGroup`/`IsMember` and invalidation seams; B19 owns every content consumer.

## Atomic transitions and stale actions

Reuse `BeginSocialWrite`; read and write membership, entries and permissions only after acquiring it. Unique constraints and triggers are the last line of defense, not the decision. Within one transaction:

- **Create group**: insert group (creator membership via trigger); commit; signal.
- **Invite / request**: resolve group and caller's role, target eligibility and existing same-pair entry; insert entry and notice together; a duplicate pair returns the existing row and inserts nothing.
- **Accept invitation / request**: verify the exact ID still exists, the actor is the decision-maker and the inviter is still a member; reconcile affected notices first (accepted for the winner, superseded for other invitations and the request), then insert the membership (its triggers delete the person's remaining pending rows), commit.
- **Refuse**: reconcile the notice, delete only that entry.
- **Leave / remove**: classify actor by role; reject creator departure; reconcile cancelled notices for the departing inviter's invitations, then delete the membership (trigger deletes those invitations), commit. Version/ID overflow fails the whole transaction.

After commit, emit the [contract signals](groups-contract.md#signals-and-invalidation); a signal failure cannot undo state or change a successful HTTP response. A write waiting on the lock re-reads state afterward, so removal followed by a delayed member write returns `404` and commits no row, notice or signal, as in the B16 permission-loss tests.

## Rebuild safety and recovery

Migration 000006 only creates tables and rebuilds `notifications`; migration 000007 only adds a nullable column, an index and triggers, so neither repeats the B15 posts rebuild or needs connection-pinned foreign-key disabling. Each must run in its migration transaction, then run `foreign_key_check` and fail on any row, with failure leaving no partial schema and a dirty version blocking readiness (never forced clean automatically). Stop old writers, then back up the consistent SQLite file plus the complete private `MEDIA_ROOT` plus any legacy mounts before upgrading. Restore a coordinated backup or repair the dirty version through the [migration guide](backend-migrations.md); never rerun destructive SQL blindly.

Down migrations refuse once any group, membership, entry, group notice or group post exists (the removal would be lossy); recovery is the coordinated backup with matching runtime. Repeated startup verifies the current schema without recreating tables or changing mappings. No hard-delete, reset or ownership-transfer workflow is added; pending DMs, avatars, post/comment media and their private bytes are preserved exactly as before.

## Surface and verification ownership

| Capability / parity | Runtime and tests | Vue / acceptance |
|---|---|---|
| Discovery, creation, member lists, invitation/request decisions, leave/remove, notices and stale identities | B18 migration/repository/API/race/notice tests against the pack | A15 fixtures; A17 real services |
| Group posts/drafts, comments, reactions, attachments, home/group feeds, profile/private activity, categories, navigation and notice consumers | B19 migration 7, predicate, writers, readers and race tests | A16 fixtures; A17 |
| Membership-change invalidation, protected-cache discipline and reconnect | B18 post-commit signals; B19 content invalidation | A15/A16; A17 |
| Preserved accounts, personal posts, discussions, notices, files and upgrades | B18/B19 preservation, failure and restart evidence | A17 combines implemented features |

B18/B19 upgrade fixtures must include public/private authors, every old post status, drafts, nested comments, reactions, read/unread follow and content notices, categories, valid/revoked sessions and avatar/post/comment/DM/pending media. Assert every old ID, value, count, notice and byte plus `sqlite_sequence` and trigger behavior after fresh, upgrade, repeated and failed startup, with failures injected before copy, before swap, during verification and before commit. B18/B19 access and race tests use the pack's eight roles, four posts, every surface, stale identity, duplicate and two-order race. B17 itself runs documentation and fixture consistency only, not these future runtime checks.

Owner approval of this data plan, the concrete interfaces and fixtures was recorded on 2026-10-09; see the [contract completion record](groups-contract.md#owner-approval-and-completion-record--2026-10-09). Migration execution and preservation evidence remain B18/B19 work.
