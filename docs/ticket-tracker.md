# Ticket Progress Tracker

This file tracks delivery progress for the real-time forum project.

## Team Assignment

| Track | Dev | Focus Area |
|-------|-----|------------|
| **A** | Dev 1 | Platform & SPA Foundations (shell, routing, auth-gating) |
| **B** | Dev 2 | Forum MVP & Features (feed, post detail, notifications, activity) |
| **C** | Dev 3 | Realtime Backend & Persistence (schema, WS server, chat APIs) |
| **D** | Dev 4 | Realtime Frontend & Verification (chat UI, WS integration, tests) |

---

Detailed ticket definitions live in:

- `docs/track-a.md`
- `docs/track-b.md`
- `docs/track-c.md`
- `docs/track-d.md`

The canonical product and technical requirements are in:

- `docs/requirements.md` — exercise specification (source of truth)
- `docs/audit.md` — audit checklist questions (source of truth)
- `docs/PRD.md` — product requirements document
- `docs/SDS.md` — software design specification

## Update Rules

1. Keep each ticket in the line format: status + ticket ID + short description + dependency fields.
2. Use `[x]` only when the verification gate in the owning track file is satisfied.
3. Use `[-]` only when a meaningful subset of that ticket already exists in code.
4. Keep `Depends on` and `Blocks` synchronized with the owning track file when ticket definitions change.
5. Do not remove completed tickets from the tracker.
6. A test ticket may start early, even if some lower-priority earlier-phase work is still open, only when all of its direct dependencies are already complete.

## Status Legend

- `[ ]` = Not Started
- `[-]` = Partially Implemented / In Progress
- `[x]` = Done

## Summary Snapshot

- Total tickets: `37`
- Done: `37`
- Partially Implemented: `0`
- Not Started: `0`

---

## Implementation Order — MVP-First Strategy

The implementation is organized into **6 waves**. Waves 1–3 deliver a functioning **MVP** that satisfies all mandatory audit requirements. Waves 4–5 deliver retained legacy features and final verification. Wave 6 delivers audit bonus features.

### Wave 1 — Foundations (P0)

> **Goal:** SPA shell, client routing, user schema, and WebSocket transport — the building blocks everything else depends on.

| # | Status | Ticket | Track | Description | Depends on | Blocks |
|---|--------|--------|-------|-------------|------------|--------|
| 1 | [x] | **A01** | A | Infrastructure, CI/CD, and Dev Tools Setup ([PR](pr-message/A01-InfrastructureSetup-pr.md)) | None | A02 |
| 2 | [x] | **A02** | A | Frontend Architecture & Directory Restructuring ([PR](pr-message/A02-FrontendArchitecture-pr.md)) | A01 | A10, D09 |
| 3 | [x] | **A10** | A | Single SPA Shell Entry ([PR](pr-message/A10-Single-SPA-Shell-Entry-pr.md)) | A02 | D09, A03 |
| 4 | [x] | **C10** | C | User Profile Schema Extension ([PR](pr-message/C10-UserProfileSchemaExtension-pr.md)) | None | C11, C02, C07 |
| 5 | [x] | **C01** | C | Authenticated WebSocket Endpoint and Connection Manager ([PR](pr-message/C01-WebSocket-Endpoint-pr.md)) | None | C04, C05, C06, D04, C08 |
| 6 | [x] | **A03** | A | SPA Boot and Client Routing ([PR](pr-message/A03-SPA-Boot-and-Client-Routing-pr.md)) | A10 | A04, D10, A05, B01, B05 |

### Wave 2 — Auth + Shell + Core Forum (P1)

> **Goal:** Auth gating, persistent shell, login/register UI, feed, post detail, comments — the core forum experience required by the audit.

| # | Status | Ticket | Track | Description | Depends on | Blocks |
|---|--------|--------|-------|-------------|------------|--------|
| 7 | [x] | **C11** | C | Registration API Contract ([PR](pr-message/C11-RegistrationAPIContract-pr.md)) | C10 | C08 |
| 8 | [x] | **A04** | A | Persistent App Shell Layout ([PR](pr-message/A04-Persistent-App-Shell-Layout-pr.md)) | A03 | A06, B01, B04, B05, D01, B06 |
| 9 | [x] | **A05** | A | Authenticated-Only Forum Access ([PR](pr-message/A05-Authenticated-Only-Forum-Access-pr.md)) | A03 | A06, B01, B04, B05, D04, C08 |
| 10 | [x] | **D10** | D | SPA Login and Registration Views ([PR](pr-message/D10-SPA-Login-and-Registration-Views-pr.md)) | A03 | D05 |
| 11 | [x] | **A06** | A | Global Logout Across the Forum ([PR](pr-message/A06-Global-Logout-Across-the-Forum-pr.md)) | A04, A05 | D05 |
| 12 | [x] | **B01** | B | Feed Route in the SPA | A03, A04, A05 | B02, B03, B06, B07 |
| 13 | [x] | **B02** | B | Remove Feed Comment Rendering ([PR](pr-message/B02-Remove-Feed-Comment-Rendering-pr.md)) | B01 | D05 |
| 14 | [x] | **B03** | B | Post Detail Route and Comment Flow ([PR](pr-message/B03-Post-Detail-Route-and-Comment-Flow-pr.md)) | B01 | D05, B06, B07 |
| 15 | [x] | **B04** | B | Create and Edit Post SPA Flows | A04, A05 | D05, B08 |
| 16 | [x] | **C02** | C | Private Messages Schema and Repository Layer | C10 | C03, C05, C06, C07 |

### Wave 3 — Real-Time Chat MVP (P2 + P3)

> **Goal:** Full chat system — roster, history, presence, DM delivery, and browser integration. Completing this wave satisfies **all mandatory audit requirements**.

| # | Status | Ticket | Track | Description | Depends on | Blocks |
|---|--------|--------|-------|-------------|------------|--------|
| 17 | [x] | **D09** | D | Frontend WebSocket Proxy | A02 | D04 |
| 18 | [x] | **C03** | C | Chat History API | C02 | D02, C08 |
| 19 | [x] | **C04** | C | Presence Broadcasting | C01 | C06, D04, C08 |
| 20 | [x] | **C05** | C | Chat Roster API ([PR](pr-message/C05-Chat-Roster-API-pr.md)) | C02, C01 | D01, C08 |
| 21 | [x] | **C06** | C | Realtime DM Send and Delivery ([PR](pr-message/C06-Realtime-DM-Send-and-Delivery-pr.md)) | C02, C01, C04 | D04, C08 |
| 22 | [x] | **D01** | D | Persistent Chat Roster UI ([PR](pr-message/D01-Persistent-Chat-Roster-UI-pr.md)) | A04, C05 | D02, D04, D06 |
| 23 | [x] | **D02** | D | Active Conversation Panel and Composer | C03, D01 | D03, D04, D06 |
| 24 | [x] | **D03** | D | Incremental History Loading ([PR](pr-message/D03-Incremental-History-Loading-pr.md)) | D02 | D06 |
| 25 | [x] | **D04** | D | Browser WebSocket Chat Integration ([PR](pr-message/D04-Browser-WebSocket-Chat-Integration-pr.md)) | D09, A05, C01, C04, C06, D01, D02 | D06, D07 |

### Wave 4 — Retained Legacy Features (P2)

> **Goal:** Migrate retained non-chat features (activity, notifications, reactions, drafts) into the SPA. These are preserved features from the previous forum, not strictly required by the real-time-forum audit but part of the product.

| # | Status | Ticket | Track | Description | Depends on | Blocks |
|---|--------|--------|-------|-------------|------------|--------|
| 26 | [x] | **B05** | B | Activity View in the SPA ([PR](pr-message/B05-Activity-View-in-the-SPA-pr.md)) | A03, A04, A05 | D05, D07 |
| 27 | [x] | **B06** | B | Notification Behavior in the SPA ([PR](pr-message/B06-Notification-Behavior-in-the-SPA-pr.md)) | A04, B01, B03 | D05, D07 |
| 28 | [x] | **B07** | B | Reaction Behavior in the SPA ([PR](pr-message/B07-Reaction-Behavior-in-the-SPA-pr.md)) | B01, B03 | D05, D07 |
| 29 | [x] | **B08** | B | Draft Workflows in the SPA ([PR](pr-message/B08-Draft-Workflows-in-the-SPA-pr.md)) | B04 | D05, D07 |

### Wave 5 — Bonus Features (P5)

> **Goal:** Audit bonus points — user profiles, DM image attachments, and concurrency patterns. These are optional features that score bonus audit points.

| # | Status | Ticket | Track | Description | Depends on | Blocks |
|---|--------|--------|-------|-------------|------------|--------|
| 30 | [x] | **A07** | A | User Profile Page (Bonus) (Note: Roster link blocked by D01) ([PR](pr-message/A07-User-Profile-Page-pr.md)) | C10, A04, A05 | D07 |
| 31 | [x] | **C09** | C | DM Image Upload Backend (Bonus) ([PR](pr-message/C09-DM-Image-Upload-Backend-pr.md)) | C02, C06 | D08, D07 |
| 32 | [x] | **D08** | D | DM Image Rendering Frontend (Bonus) | C09, D02, D04 | D07 |

### Wave 6 — Finalization & Acceptance (P3–P4)

> **Goal:** Database migration, full test coverage, and final project acceptance.

| # | Status | Ticket | Track | Description | Depends on | Blocks |
|---|--------|--------|-------|-------------|------------|--------|
| 33 | [x] | **C07** | C | Database Migration Strategy ([PR](pr-message/C07-Database-Migration-Strategy-pr.md)) | C10, C02 | D07 |
| 34 | [x] | **C08** | C | Backend Test Coverage for Auth, Messaging, and Presence ([PR](pr-message/C08-Backend-Test-Coverage-pr.md)) | C11, A05, C01, C03, C04, C05, C06 | D07 |
| 35 | [x] | **D05** | D | SPA and Forum Frontend Regression Coverage ([PR](pr-message/D05-SPA-Forum-Regression-Coverage-pr.md)) | D10, A06, B02, B03, B04, B05, B06, B07, B08 | D07 |
| 36 | [x] | **D06** | D | Chat Frontend Regression Coverage ([PR](pr-message/D06-Chat-Frontend-Regression-Coverage-pr.md)) | D01, D02, D03, D04 | D07 |
| 37 | [x] | **D07** | D | Final Acceptance Validation ([PR](pr-message/D07-Final-Acceptance-Validation-pr.md)) | B05, B06, B07, B08, C07, C08, D04, D05, D06, A07, C09, D08 | None |

---

## MVP Boundary

Completing **Waves 1–3** (tickets 1–25) delivers a fully functioning real-time forum that passes **all mandatory audit requirements**:

- ✅ SPA with single HTML file
- ✅ Registration with all required fields
- ✅ Login with nickname or email
- ✅ Auth-gated forum access
- ✅ Logout from any page
- ✅ Posts with categories in feed
- ✅ Comments only on post detail
- ✅ Online/offline user list
- ✅ Roster ordered by last message / alphabetical
- ✅ Private messaging in real time
- ✅ Message format with date and username
- ✅ Last 10 messages loaded initially
- ✅ Scroll-up pagination with throttle/debounce
- ✅ Real-time notification of new messages (unread badge per roster row plus a
  roster-wide total, so an arriving DM is visible without the thread open)

## Recent Completion Notes

- **B01 / B02 / B03**: the forum content flow is now fully split between feed and post detail.
- **Post detail inside SPA shell**: opening a post renders `/posts/:id` without a full document reload.
- **Comments isolated to post detail**: comment fetching no longer occurs in the feed and loads only from the post-detail initializer.
- **Feed remains decoupled**: feed data flow stays post-only while preserving SPA navigation into post detail.
- **Comment interactions preserved**: comment submission and comment image upload both work from the SPA post-detail screen.
- **B05 — Activity in the SPA**: `/activity` is now a SPA feature slice
  rendered inside the shared authenticated shell. The new module set
  lives at `SPA/features/activity/` (`activity.api.js`,
  `activity.views.js`, `activity.page.js`) and is wired through
  `SPA/core/router/routes.js`, `SPA/core/router/render-template.js`, and
  `SPA/core/app/create-app.js`. The legacy `web/templates/activity.html`
  template and all `web/static/js/activity/*` scripts have been deleted.
  Activity navigation and mutations (status toggle, delete post, edit
  comment, delete comment) no longer rely on hard `window.location`
  reloads — deep-link refresh, browser back/forward, and filter/pagination
  state are all handled through SPA history APIs.
- **Activity cleanup**: the orphaned legacy `web/static/css/activity.css` has
  been deleted as part of B05 (it was not loaded by any template or the SPA
  bundle).
- **Create-post follow-up**: `web/static/js/create-post.js` still performs a
  hard `window.location.href = '/activity'` navigation — a pre-existing B04
  leak from the still-standalone create-post flow, tracked for the create-post
  SPA migration.

---

## Ticket ID Index

- Track A: `A01` through `A10`
- Track B: `B01` through `B08`
- Track C: `C01` through `C11`
- Track D: `D01` through `D10`

## Cross-Document References

- Exercise specification: `docs/requirements.md`
- Audit checklist: `docs/audit.md`
- Product requirements: `docs/PRD.md`
- Technical design: `docs/SDS.md`
- Track A definitions: `docs/track-a.md`
- Track B definitions: `docs/track-b.md`
- Track C definitions: `docs/track-c.md`
- Track D definitions: `docs/track-d.md`
