# Phase 4 integrated acceptance — SN-A17

Implementation on `chbaikas/A17`, based on merged main `025c849` (A16 and B19 included). The [groups contract](groups-contract.md), [group content extension](groups-contract.md#group-content-extension), [Phase 4 data plan](phase-4-data-plan.md) and [Phase 4 decisions](phase-4-decisions.md) control expectations. Status lives in the [tracker](ticket-tracker.md). The local gate passed; the hosted gate is **pending** (nothing has been pushed), so the ticket is not marked complete.

## Execution boundary

[Real-service A17 journeys](../../SPA/tests/e2e/a17-acceptance.test.js) use the existing [B07 two-image harness](shared-runtime.md) through `playwright.integration.config.ts`. Each journey registers unique accounts over real HTTP into disposable SQLite/media storage; independent browser contexts own real session cookies and sockets. No HTTP, socket, group, notice or content fixture is mocked, and no application code changed. Container recreation refuses any project outside the isolated `sn-b07-test-*` convention. Docker was already running; this work did not start the daemon.

```bash
make test-browser PLAYWRIGHT_ARGS=a17
make check
```

## Coverage

| Requirement | Executable evidence |
|---|---|
| Discovery, creation, requests | Keyboard group creation, name search, role-dependent card (no member count for nonmembers), request by keyboard, idempotent duplicate, nonmember/requester decision attempts `404`, nonmember member-list and request-list `404`. |
| Creator-only decisions and removal | Creator accepts from the real notice; resolved request replay is `409 STALE_JOIN_REQUEST`; refusal is not a ban (new request gets a new ID); ordinary members cannot remove (`404`); creator removal then replay is `409 STALE_MEMBERSHIP`; creator leave is `409 CREATOR_CANNOT_LEAVE`. |
| Member invitations | Member invites, duplicate pair is `200` same ID, outsider/self/already-member rejected, invitee accepts from the browser list, resolved notice is `accepted` with no actions, replayed accept/refuse are `409 STALE_INVITATION`. |
| Inviter departure, readmission | Leaving cancels only the leaver's invitations (notices `cancelled`, no actions); creator's invitation stays pending; accepting a stale invitation never admits; the returning inviter gets a new membership ID and cannot revive the old invitation; siblings become `superseded` and the pending request is deleted on accept; exactly one membership. |
| Private authors, nonmember followers | Private author's group post, comment and PNGs are readable by members without profile access (`/users/{id}/posts` stays `404` for a non-follower member); a nonmember follower with full profile access, pending requester, invitee and outsider are denied on detail, thread, comment, navigation, group and home feeds, media, mine/liked/disliked/categories/activity, mutations and static aliases. |
| Membership loss, retained contributions | Live open page closes on departure; every read/write path, own drafts, activity, notices, media and direct links return `404`/empty; remaining members keep post, comment, image, likes and author name; other drafts stay hidden from the creator; fresh admission restores the author's own contributions and draft; creator removal denies identically. |
| Privacy and aggregates | Personal followers-only post is not widened by shared membership; `group_id` mixing and conversion are rejected; per-category totals, category view and navigation agree with feeds; unpublish/republish adjusts totals. |
| Signals, recovery, session cleanup | Live removal updates open pages; offline-then-reconnect refetch denies a missed removal; sign-out, back and protected direct entry reveal nothing and API reads return `401`. |
| Restart persistence | Both containers recreated with retained storage: membership, pending invitations/requests with their notices, drafts, reactions, exact image bytes and departed-author denial survive; stale IDs stay stale; pending entries still resolve. |
| Keyboard/mobile/desktop | Keyboard group publishing, comment and creator removal at 1280px and 360px; no horizontal overflow; screenshots inspected. |
| Preserved features | The full prior integration suite (A07/A11/A14/B07/B13, 29 journeys) runs alongside in the same gate. |

## Verification record — 2026-10-14

`make test-browser PLAYWRIGHT_ARGS=a17` passed **8/8** after two test-expectation corrections (a personal post without a category cannot be a navigation anchor; the category-total arithmetic mixed viewers). No application behavior changed.

`make check` passed with **exit 0** on a clean tree plus these test/doc changes: Biome, gofmt, vet, Go and race suites, Vitest **2100/2100**, native Playwright **62/62**, both image builds, backend and media smoke, integration Playwright **37/37** (29 earlier-phase plus 8 A17), stopped-backend outage handling and disposable cleanup. No retries. Log: `.tmp/a17-final-check.log`.

Not yet verified: the hosted `make check` run (requires a push/PR). Phase 5 planning is not acceptance evidence and is untouched.
