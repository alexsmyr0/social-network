# Track C - Realtime Backend, Persistence, and Backend Validation

## Mission

Track C owns the realtime server spine:

- authenticated WebSocket transport
- user-profile schema changes
- direct-message persistence
- roster and history APIs
- presence broadcasting
- realtime message delivery
- backend migration strategy
- backend test coverage
- DM image upload backend (bonus)

This track should stay backend-focused and avoid owning browser UI except where API and event contracts must be defined.

## Source Mapping
- C01 -> RTF-18, C02 -> RTF-15, C03 -> RTF-17, C04 -> RTF-19, C05 -> RTF-16, C06 -> RTF-20, C07 -> RTF-25, C08 -> RTF-26, C09 -> RTF-34 (bonus), C10 -> RTF-05, C11 -> RTF-06

## Suggested Execution Order
1. C01, C10 | 2. C11, C02 | 3. C03, C04 | 4. C05, C06 | 5. C07, C08 | 6. C09 (bonus)

## Tickets

### C01 - Authenticated WebSocket Endpoint and Connection Manager
Source: RTF-18 | Phase: P0
Depends on: None
Blocks: C04, C05, C06, D04, C08

Work:
- add `GET /ws`
- validate session cookies during upgrade
- manage connection lifecycle per user
- support multiple connections for the same user

Verification Gate:
- authenticated users can open WebSocket connections
- unauthenticated connections are rejected
- multi-tab connection lifecycle is tracked reliably

### C02 - Private Messages Schema and Repository Layer
Source: RTF-15 | Phase: P1
Depends on: C10
Blocks: C03, C05, C06, C07

Work:
- add the `private_messages` table
- add repository functions for message creation and pair-based history lookup
- add the required indexes

Verification Gate:
- messages can be persisted between two users
- pair-based history queries work
- schema and repository tests cover the new table

### C03 - Chat History API
Source: RTF-17 | Phase: P2
Depends on: C02
Blocks: D02, C08

Work:
- add `GET /api/v1/chats/{userID}/messages`
- support latest-10 fetch
- support `before_id` pagination for older history
- return render-ready chronological order

Verification Gate:
- the first request returns the latest 10 messages
- older history returns in batches of 10
- the API exposes whether more history exists

### C04 - Presence Broadcasting
Source: RTF-19 | Phase: P2
Depends on: C01
Blocks: C06, D04, C08

Work:
- keep in-memory presence state from active connections
- emit `presence.snapshot` on connect
- emit `presence.update` on actual online-state transitions

Verification Gate:
- new clients receive a presence snapshot
- first connection marks a user online
- last disconnect marks a user offline

### C05 - Chat Roster API
Source: RTF-16 | Phase: P2
Depends on: C02, C01
Blocks: D01, C08

Work:
- add `GET /api/v1/chats`
- include all other users
- include presence and last-message metadata
- enforce required roster ordering

Verification Gate:
- roster entries include `is_online` and last-message metadata
- users with history sort by latest activity
- users without history sort alphabetically after active conversations

### C06 - Realtime DM Send and Delivery
Source: RTF-20 | Phase: P2
Depends on: C02, C01, C04
Blocks: D04, C08

Work:
- validate outbound `dm.send`
- reject invalid, self-directed, or offline-recipient sends
- persist valid messages
- emit `dm.message` and `chat.error`

Verification Gate:
- valid direct messages are persisted and delivered to sender and recipient
- invalid sends are rejected with the agreed contract
- delivered payloads match the SDS event shape

### C07 - Database Migration Strategy
Source: RTF-25 | Phase: P3
Depends on: C10, C02
Blocks: D07

Work:
- define migration logic for new user fields and private messages
- preserve existing retained tables and data
- define handling for pre-existing users after schema change

Verification Gate:
- schema changes can be applied to an existing database
- existing users remain usable
- retained forum data is preserved

### C08 - Backend Test Coverage for Auth, Messaging, and Presence
Source: RTF-26 | Phase: P4
Depends on: C11, A05, C01, C03, C04, C05, C06
Blocks: D07

Work:
- add backend tests for extended registration
- add login-by-username and login-by-email tests
- add auth-gating, roster, history, websocket auth, presence, and DM integration tests

Verification Gate:
- backend tests cover the major auth and chat flows
- both supported login modes are explicitly tested
- offline-recipient and multi-connection presence cases are covered

### C09 - DM Image Upload Backend (Bonus)
Source: RTF-34 | Phase: P5 (Bonus)
Depends on: C02, C06
Blocks: D08, D07

Work:
- add `image_path TEXT DEFAULT NULL` column to `private_messages`
- add `POST /api/v1/chats/{userID}/images` endpoint for DM image uploads
- reuse existing image upload validation (max size, allowed types)
- save uploaded images to `web/static/uploads/dm/`
- extend `dm.send` WebSocket event to accept optional `image_url` field
- extend `dm.message` event to include `image_url` when present
- extend history API responses to include `image_url`

Verification Gate:
- DM image upload saves the file to disk and returns a valid URL
- messages with images are persisted with the `image_path` column populated
- `dm.message` events include `image_url` when an image is attached
- history API returns `image_url` for messages that have images

### C10 - User Profile Schema Extension
Source: RTF-05 | Phase: P0
Depends on: None
Blocks: C11, C02, C07

Work:
- extend the users schema with `age`, `gender`, `first_name`, and `last_name`
- update repository models and scanning
- preserve existing user reads

Verification Gate:
- new users persist all required profile fields
- existing user reads do not break
- repository coverage exists for the new fields


### C11 - Registration API Contract
Source: RTF-06 | Phase: P1
Depends on: C10
Blocks: C08

Work:
- extend the registration payload and validation
- validate age and required profile text fields
- keep existing valid username, email, and password rules

Verification Gate:
- registration rejects missing required profile fields
- valid extended payloads succeed
- successful registration still creates a session

