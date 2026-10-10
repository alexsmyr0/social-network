# Group discovery and membership — SN-A15

Implemented on `chbaikas/A15`, based on merged main `fcefdaa` (B17 and B18 included). The [owner-approved groups contract](groups-contract.md), [fixture pack](fixtures/phase-4-contract.json) and [Phase 4 decisions](phase-4-decisions.md#discovery-membership-and-departure) control the implementation. Status lives in the [tracker](ticket-tracker.md). This ticket verifies the Vue frontend with fixtures. Real-service authorization, persistence and delivery belong to SN-A17; group posts and discussions belong to SN-A16.

## Delivered behavior

**Discovery** (`/groups`) lists every group, newest first, with a literal title search and an All groups / Your groups switch. Search, filter and page live in the URL, and malformed values recover to the nearest valid view. Cards show the title, description, creator name and the viewer's state (Creator, Member, Invited or Requested). The member count appears only when the server sends it, which it does only for members. Nonmembers see Request to join, a pending-request note, or Accept/Refuse for each of their own invitations. The page also shows a paginated "Invitations for you" list from `/users/me/group-invitations`. Loading, empty, beyond-last-page and outage states each have recovery controls. A slow earlier search never repaints over a newer one.

**Creation** (`/groups/new`) mirrors the contract text rules before sending anything: trim, CRLF→LF, 1–100 and 1–1000 code points, no control characters in titles, and newline/tab allowed in descriptions. Server field errors map to the same messages and move focus to the first problem. One submission is in flight at a time. On success the creator lands on the new group. Creation is not idempotent, so a lost response is never resent. The draft stays, and the message links to Your groups, where a committed group already appears. An account change clears the unsent draft.

**Group view** (`/groups/:id`, `/members`, `/requests`) loads the group first and decides the sections from the server-reported role:

| Viewer | About | Members | Join requests |
|---|---|---|---|
| Outsider, follower, departed member | Metadata, Request to join | Members-only notice; list never requested | Creator-only notice; never requested |
| Pending invitee / requester | Accept/Refuse per invitation by exact ID / pending note | Same as outsider | Same as outsider |
| Ordinary member | Member state, Leave (with confirmation), Invite people | List; no Remove controls | Creator-only notice; never requested |
| Creator | Creator state; no Leave control | List; Remove (with confirmation) for other members only | Accept/Refuse per request |

Member rows reuse B10 People redaction. A private profile appears name-only, with no avatar, and links to the profile route, which applies its own access rules. Inviting searches People, hides the viewer, and reports each person's outcome beside them ("Invitation pending", "already a member", unavailable). An invitation alone grants nothing.

**Departure and return.** Leave and removal both use `DELETE /group-memberships/{id}` with the membership ID shown by the server. After leaving or removal, the departed user sees discovery metadata and Request to join, and the members route no longer requests the list. Returning needs a fresh request (creator decision) or a fresh invitation (any member), and creates a new membership ID. An old ID is stale.

**Group notices** use the A10 panel. `group_invitation` and `group_join_request` notices show the actor, the state ("Invited you to join", "Join request accepted", "Invitation cancelled · the inviter left the group", "… closed · they joined another way") and a link to the group. Pending notices act on the exact `invitation_id`/`request_id`, and the server rechecks the decision-maker. Resolved notices have no actions. Before A15, any group notice made the whole notice list unavailable; the normalizer now accepts both types with their state sets and drops anything beyond public group metadata.

## No false membership success

All writes go through `group-state.js`. Each entry has one pending action, so a double click sends one request. Responses that arrive after an account change are ignored. 401s go to the shared session handler. Nothing is ever replayed automatically. A success message appears only for a confirmed `ok`. Each pinned conflict has its own message: `STALE_INVITATION`, `STALE_JOIN_REQUEST`, `STALE_MEMBERSHIP`, `ALREADY_MEMBER` and `CREATOR_CANNOT_LEAVE`. 404, rejected and uncertain outcomes say what is known. Decisions, leave and removal always invalidate every mounted protected view, whatever their outcome. An uncertain write may have committed, and a stale one means someone else changed the group. Lists that held the button are discarded and refetched, so outcomes are reported through a page-level live region provided to child controls. That region receives focus. Vue drops events from a control that unmounted mid-request, which is why reporting does not use events.

## Protected state and the A16 handoff

Every group read reuses `useSocialResource`. Signals, reconnect, focus, route and account changes discard results before refetching. Newer loads supersede older responses. Failed reads clear details, and the 60-second visible-screen fallback continues. Group and list resources include the account ID as a source, so switching accounts never shows the previous member list. Members and join-request lists mount only after the group read confirms the role. The server's 404 still governs any later read.

| Area | Files / handoff |
|---|---|
| Strict group client (normalization, redaction, pinned conflicts) | `SPA/src/api/groups.js`; group notice types in `SPA/src/api/social.js` |
| Shared guarded writes and messages | `SPA/src/features/groups/group-state.js` (provided as `groupsKey` in `main.js`) |
| Routed group and role, section rules | `use-group.js` (`useGroup`, `groupSections`), `GroupNav.vue` — **A16 entry point**: add a posts section/route that calls `useGroup()` and mounts group content only while `isMember` |
| Outcome reporting | `use-group-feedback.js`, `GroupFeedback.vue` |
| Views | `GroupsPage.vue`, `GroupCard.vue`, `InvitationList.vue`, `GroupCreatePage.vue`, `GroupPage.vue`, `MembershipActions.vue`, `GroupMembers.vue`, `GroupRequests.vue`, `GroupInvitePanel.vue` |
| Shell, routes and notices | `SPA/src/app/App.vue`, `SPA/src/app/router.js` (group filter canonicalization), `NotificationCenter.vue` |
| Layout | `SPA/src/styles/groups.css`, existing Commonplace tokens and social patterns |
| Test fixtures | `SPA/tests/fixtures/phase4/group-backend.js` (stateful model, pack-conformant), `browser.js`; frontend evidence only |

No Go, schema or shared-runtime changes are needed. The native Playwright configuration includes A15. SN-B07 remains the shared image/CI owner.

## Verification record

Commands on the A15 working tree based on `fcefdaa`, 2026-10-10:

```bash
bun run test:a15
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-e2e PLAYWRIGHT_ARGS=a15-groups
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-images
python3 docs/social-network/fixtures/validate-phase-4.py
git diff --check
```

- **Client replay: 207/207** group-owned approved cases (every group, invitation, request and membership route, plus seven group-notice cases and two hidden group-content notice reads). Each case asserts the outcome status and the normalized data and pagination. 180 of them also assert the exact method, path, JSON body, credentials and write header. The other 27 are server-only rejections the client never emits, such as unknown query keys, malformed JSON and wrong methods; for those only the outcome mapping is checked. Six more cases cover redaction (outsider `member_count`, creator/teaser fields, leftover member entries), malformed bodies, lost writes, non-creator creation responses and resolved notice actions.
- **Test model conformance: 195 pack cases** (all expressible group-owned cases; 10 origin/raw-encoding transport cases excluded), **5/5 journeys** and **9 group races in both orders**. The checks cover exact statuses, bodies, pinned messages, unchanged state, expected state and signal recipients, so the UI tests below run against the approved semantics.
- **Interaction checks: 44/44.** Discovery and creation: 12. Role controls, admission, departure, stale/simultaneous/uncertain actions, notices, signals, account switching, 401 and outage: 26. Shared write guard: 6. These include every role's permitted controls, protected lists that are never requested, a held accept that shows no success before commit, inviter departure making an open invitation stale, a request admitted elsewhere, leave versus removal, a committed outcome with a lost response, refusal followed by a fresh request, removal followed by return with a new membership ID, notice decisions by exact ID, signal discard, missed-signal reconnect and delayed pre-removal responses.
- `bun run test:a15`: **672/672**, including A09/A10 social and notification, shell/router and production-fixture policy regressions.
- **Browser: 7/7 A15 journeys.** Keyboard creation and validation recovery. Keyboard request plus creator admission from the notice. Stale invitation, single accept on a double click, then leave. Removal signal reaching the removed member, then return by fresh request. Direct routes and sign-out/account switching. Outage retry and reconnect refetch. 360px/1280px layouts with no horizontal scroll and buttons at least 44px tall. Screenshots `.tmp/a15-groups-{360,1280}.png` and `.tmp/a15-group-{360,1280}.png` were inspected: long titles and descriptions wrap, mobile actions stack full-width, and the views keep the existing palette and typography.
- Native `make test` returned **exit 0**: builds, Biome, gofmt, vet, Go suite, scoped race suite, Vitest **1655/1655** (84 files, statements 90.88%) and Playwright **54/54**, including the 7 A15 journeys. One earlier run failed `TestSocialPresenceSnapshotsRefreshWithCurrentProfilePermission`, a Go presence test with a timing dependency. This branch changes no Go code. That test passed 5/5 in isolation, and the next full run passed. Another run failed once on `a03-shell` "completes registration against a contract fixture on desktop", the registration-fixture race noted in the [B15 record](backend-publishing.md). It reproduces on unchanged `main` (1 of 144 repeated runs), so A15 did not introduce it. The final full run on the PR tree passed.
- `validate-phase-4.py` passes (389 cases, journeys, races, links and the 36-ticket graph with **33 complete, 0 in progress, 3 unstarted**); `git diff --check` passes.

Docker was already running. `make test-images` returned **exit 0**: both image builds, backend smoke, legacy-media recovery/participant access/static denial, two-image transport/outage smoke and **29/29** existing real-service A07/A11/A14/B07/B13 journeys passed. These are earlier-phase regression checks. Hosted CI and real Phase 4 group acceptance remain unverified by this ticket and belong to SN-A17.

## Findings resolved during verification

- Group notices previously failed normalization, so an invitee's or creator's whole notification list became "unavailable" once B18 emitted them. A15 adds both notice types.
- Membership writes unmount the row that holds their button before the response arrives, and Vue drops events from unmounted components. Outcomes are therefore reported through a provided page-level function instead of events.
- A text `<input>` strips newlines, so title newline validation is exercised with a control character in the UI tests. The client and model still enforce the contract rule.
