# Phase 4 — Approved Group Decisions

Recorded on 2026-10-02 from the owner's planning interview. This extends the [Phase 2–3 decisions](phase-2-3-decisions.md) for [groups and membership](roadmap.md#phase-4-boundary-and-exit). The owner authorized ticket authoring and publishing, not application implementation. Status remains in the [tracker](ticket-tracker.md).

## Approval and scope

The owner approved group membership as the content boundary, contribution preservation after departure, group discovery, creator removal powers, cancellation of invitations from departed inviters, and the storage/content extension below. The discovery approval was conditional on the assignment requiring browsable groups; [the supplied requirement](requirements.md#groups) explicitly requires a section for browsing all groups.

Phase 4 receives six tickets at the same requested 2–3× Phase 1 scope, leaning toward three related slices per outcome. Phase 3 acceptance still gates execution. Group events and chat remain Phase 5; no event/chat implementation is implied by group membership approval.

## Discovery, membership and departure

| Topic | Approved behavior |
|---|---|
| Creation | A signed-in user creates a group with a title and description and becomes its creator/member. |
| Discovery | Signed-in users can browse all groups. Nonmembers see title, description, creator display name and join/request controls. Member lists, posts, attachments and chat remain members-only. |
| Invitations | Any current member may invite another user. The recipient accepts or refuses; an invitation alone grants no membership or content access. |
| Join requests | A nonmember can request to join. Only the creator accepts or refuses the request; ordinary members cannot decide it. |
| Admission | Accepting an invitation or join request creates one membership and resolves the person's other pending invitations/requests for that group. |
| Voluntary departure | Ordinary members may leave. The creator remains a member while the group exists; ownership transfer is additional, unapproved scope. |
| Removal | The creator may remove another member. Ordinary members cannot remove anyone; no moderator roles are added. |
| Return after removal | Removal is not a ban. The user may request again or accept a fresh invitation from any current member. Return does not require creator-only permission. |
| Departed inviter | Leaving or removal cancels that member's still-pending invitations. A current member may send a fresh invitation; an obsolete invitation cannot become valid merely because its inviter rejoins. |
| Contributions | Departed members' posts/comments remain stored and available to remaining members under publication rules. The departed author loses group-content access, including through direct links and media. |

Group discovery does not expose additional private-profile information about the creator. Member lists and content attribution also retain the established profile-field restrictions: group membership grants content access, not access to an author's private registration details or avatar.

## Group content and existing features

Group posts appear in the group view and current members' home feeds. Their access depends on current membership, regardless of the author's profile privacy or the viewer's follow relationship. A personal-post audience cannot widen group access. Conversely, a private author does not hide their published group post from another member.

| Viewer / content state | Group content access |
|---|---|
| Current member, published post | May read the post, comments and attachments; may interact under existing ownership rules. |
| Current member, own draft | May read/edit the draft and manage publication. Other members cannot read it. |
| Nonmember or departed author | No group-content access, including their retained contributions and drafts. Discovery metadata remains available. |

Reuse Phase 3 comments, reactions, optional titles/categories, JPEG/PNG/GIF, image-only content, drafts, publication controls, author editing/deletion and supported reply relationships. Author mutations additionally require current membership. The creator's removal power does not add permission to edit/delete other authors' content. No group deletion, ownership-transfer, moderation-role or personal-to-group post conversion workflow is included.

Keep group scope visible in feeds and editors; the personal audience picker does not control group access. Profile activity still requires access to the profile and underlying post. Private activity, categories, counts, previous/next navigation, notifications and attachment URLs must not bypass membership. Leaving/removal preserves records while denying future reads/writes; rejoining establishes current membership again. Material already viewed or saved cannot be retracted.

## Approved architecture and handoffs

Extend the existing SQLite database with separate `groups`, `group_memberships`, `group_invitations` and `group_join_requests` tables. Invitations and requests have different decision-makers and remain separate. Admission resolves pending entries transactionally with membership creation. Creator membership, uniqueness, authorization and stale-action handling must hold under concurrent accept/refuse/leave/remove operations.

Extend existing posts with an optional `group_id`; existing posts remain personal. Reuse comments, reactions and protected media rather than building a second content system. The shared permission layer chooses personal-post rules or group-membership rules according to post scope, and applies publication/ownership checks as appropriate. Filter before pagination, totals and navigation. Data-preserving migrations must retain earlier-phase IDs, records and file associations; the initial fresh-database policy does not authorize resets.

Reuse persisted notifications and the existing session-owned WebSocket. Invitation notifications go to invitees; join-request notifications go to the creator. Save notices with the triggering transaction and signal after commit. Notification actions must address the exact invitation/request, recheck the decision-maker and current state, and reject obsolete actions. Pending-invitation cancellation and admission reconcile corresponding notices. Group-content notices and excerpts require current membership. Nonmembers may read their own invitation and public group metadata without receiving content previews.

Membership changes invalidate affected open views; current permissions remain authoritative on every server read/write. Refetch on reconnect recovers missed signals. General notices remain distinct from message indicators. No new queue, socket, database or service is approved.

SN-B17 translates these settled choices into planned `groups-contract.md`, `phase-4-data-plan.md` and reviewed fixtures. It records concrete routes, payloads, errors, pagination, duplicate-action rules, request identities, membership generations or equivalent stale-action protection, and migration/recovery mappings. These details require one owner approval of interfaces and fixture handoff, plus fixture completeness/consistency checks before consumers start; the handoff does not reopen settled product/storage choices.

SN-B18 owns membership transitions and transactional invitation/request notices; SN-B19 applies membership across content, media and existing aggregate/notification consumers. SN-A15/A16 may finish against approved fixtures. SN-A17 requires real multi-user browser/API/media checks through both images. B retains shared runtime/CI ownership under SN-B07; A supplies browser scenarios and acceptance evidence.

## Deferred phases

**Phase 5 is pending at the owner's request.** No Phase 5 tickets are authored. The last questions about asymmetric direct-message delivery, offline sending, and history/attachment access after both users unfollow were unanswered; no proposal from that batch is approved. Events, chat models and remaining messaging behavior still need an interview. Preserve existing DMs, images, presence, history and unread behavior for that adaptation.

Phase 6 remains a roadmap work package, with final-delivery decisions and tickets still to follow. Neither deferred phase is marked complete or represented by invented dependency IDs.
