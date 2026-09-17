# Track D - Realtime Frontend, Browser Integration, and Final Verification

## Mission

Track D owns the browser-side realtime chat experience and the final frontend integration layer:

- persistent chat roster UI
- active conversation panel
- incremental history loading
- browser WebSocket integration
- SPA and forum regression coverage
- chat-specific frontend regression coverage
- final acceptance validation
- DM image rendering frontend (bonus)

This track is the main integration consumer. It depends on Track A for shell/auth and Track C for chat contracts.

## Source Mapping
- D01 -> RTF-21, D02 -> RTF-22, D03 -> RTF-23, D04 -> RTF-24, D05 -> RTF-27, D06 -> RTF-32, D07 -> RTF-28, D08 -> RTF-35 (bonus), D09 -> RTF-02, D10 -> RTF-07

## Suggested Execution Order
1. D09 | 2. D10, D01 | 3. D02 | 4. D03 | 5. D04 | 6. D05 | 7. D06 | 8. D08 (bonus) | 9. D07

`D05` is intentionally split so SPA/forum regression work can start once Track B stabilizes; it does not need to wait for `D04`.

All frontend implementations must use only modern vanilla JS ES2026+ with optimal best practice patterns. Dev tools and runtime use Bun, linting/formatting via Biome, and all testing (unit, integration, e2e) uses Vitest.

## Tickets

### D01 - Persistent Chat Roster UI
Source: RTF-21 | Phase: P3
Depends on: A04, C05
Blocks: D02, D04, D06

Work:
- render the always-visible user roster in the authenticated shell
- show online/offline state and last-message preview metadata
- keep all rostered users selectable, including offline users
- add links from rostered users to their profiles (/profile/:id) as defined in A07

Verification Gate:
- the roster is visible on authenticated routes
- presence state is shown per user
- roster order matches backend ordering
- all rostered users remain selectable

### D02 - Active Conversation Panel and Composer
Source: RTF-22 | Phase: P3
Depends on: C03, D01
Blocks: D03, D04, D06

Work:
- render selected conversation history
- display sender username and message timestamp
- allow selecting any rostered user
- render empty-state conversations when there is no history
- disable sending when the selected user is offline

Verification Gate:
- selecting a user loads the latest 10 messages
- offline history remains readable
- selectable users with no history show a valid empty state
- sending is disabled in the UI when the selected user is offline

### D03 - Incremental History Loading
Source: RTF-23 | Phase: P3
Depends on: D02
Blocks: D06

Work:
- load older history in batches of 10
- use throttle or debounce for scroll-triggered loading
- preserve stable scroll position when prepending history

Verification Gate:
- older messages load in batches of 10
- repeated scroll events do not cause burst requests
- the viewport remains usable after prepending history

### D04 - Browser WebSocket Chat Integration
Source: RTF-24 | Phase: P3
Depends on: D09, A05, C01, C04, C06, D01, D02
Blocks: D06, D07

Work:
- open the WebSocket after authenticated app boot
- emit `dm.send` from the composer
- consume presence and message events
- update active conversation and roster ordering live
- surface send and delivery errors in the UI
- explicitly defer automatic reconnect, backoff, and disconnected-state recovery for this phase

Verification Gate:
- presence changes update the roster without refresh
- outbound messages are emitted through the agreed WebSocket contract
- incoming messages appear live in the active conversation
- message activity reorders the roster correctly
- send and validation errors are visible in the UI
- automatic reconnect and connection-loss recovery are out of scope for this ticket

### D05 - SPA and Forum Frontend Regression Coverage
Source: RTF-27 | Phase: P4
Depends on: D10, A06, B02, B03, B04, B05, B06, B07, B08
Blocks: D07

Work:
- cover auth routes, auth boot, and logout visibility
- cover feed vs post-detail comment visibility
- cover create/edit post, activity, drafts, notifications, and reactions in the SPA
- cover post and comment image-upload flows

Verification Gate:
- frontend regression coverage exists for the main SPA transitions
- logout visibility is explicitly protected
- image-upload flows are protected
- retained legacy SPA flows covered by this phase are protected

### D06 - Chat Frontend Regression Coverage
Source: RTF-32 | Phase: P4
Depends on: D01, D02, D03, D04
Blocks: D07

Work:
- cover offline composer behavior
- cover offline-history readability and empty conversation states
- cover live message rendering and chat send-error handling
- cover roster presence, roster reordering, and incremental history loading behavior

Verification Gate:
- offline composer behavior is explicitly protected
- offline history readability and empty-state conversations are tested
- live message rendering and send-error handling are covered
- presence rendering, roster reordering, and history-loading behavior are tested

### D07 - Final Acceptance Validation
Source: RTF-28 | Phase: P4
Depends on: B05, B06, B07, B08, C07, C08, D04, D05, D06, A07, C09, D08
Blocks: None

Work:
- execute the final acceptance checklist against the PRD and SDS
- verify retained legacy features still function
- record any remaining gaps as follow-up work instead of hidden work
- confirm Vitest covers unit, integration, and E2E tests properly in `SPA/tests/` folder hierarchy

Verification Gate:
- the build satisfies the documented product success criteria
- retained features are confirmed working or explicitly flagged
- remaining gaps are listed as follow-up items

### D08 - DM Image Rendering Frontend (Bonus)
Source: RTF-35 | Phase: P5 (Bonus)
Depends on: C09, D02, D04
Blocks: D07

Work:
- add image attachment button to the DM composer
- upload selected image via `POST /api/v1/chats/{userID}/images`
- include returned `image_url` in the `dm.send` WebSocket event
- render images inline in the conversation panel (both sent and received)
- display images in chat history loaded from the API
- preserve image rendering during incremental history loading

Verification Gate:
- a user can select and upload an image in the DM composer
- the image is displayed inline in the conversation for both sender and recipient
- images are visible in chat history on page reload
- image rendering works correctly with incremental history loading

### D09 - Frontend WebSocket Proxy
Source: RTF-02 | Phase: P2
Depends on: A02
Blocks: D04

Work:
- proxy `/ws` traffic from the frontend server to the backend
- preserve existing REST proxy behavior
- ensure authenticated cookies survive proxying

Verification Gate:
- a browser client can connect to `/ws` through the frontend server
- the proxied request reaches the backend with the session cookie intact
- REST proxy behavior is not regressed


### D10 - SPA Login and Registration Views
Source: RTF-07 | Phase: P1
Depends on: A03
Blocks: D05

Work:
- build SPA login and registration screens
- add extended registration fields
- support login by username or email
- remove guest and OAuth entry paths from the UI

Verification Gate:
- login and registration routes render inside the SPA
- registration includes all required fields
- login accepts username or email entry
- guest and OAuth entry options are not exposed

