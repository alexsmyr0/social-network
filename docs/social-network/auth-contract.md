# Account and Session Contract

Owner-approved decision for [SN-B02](track-b.md#sn-b02--approve-auth-contracts), based on the [assignment](requirements.md#authentication), [approved frontend boundary](frontend-decision.md) and [backend baseline](backend-baseline.md). Prepared on 2026-09-24 against merged SN-A02 at `525b19e`.

The project owner approved this contract in chat on 2026-09-24 with “Approve proposed contract”. Approval covers the interfaces, validation, avatar flow/access, independent sessions, current-session logout, and the renewable 400-day cookie with its browser-retention limitation. On 2026-09-26, the owner confirmed in chat that Dev 1 had reviewed the examples and found them usable for independent A04/A05 UI fixtures. This records the remaining review gate; it does not claim implemented endpoints. Ticket status lives in the [tracker](ticket-tracker.md).

## Owner-approved decisions

| Choice | Decision and rationale | Alternative / tradeoff |
|---|---|---|
| Identity | Email-only login; optional, non-unique nickname; numeric user ID is identity. Display nickname when present, otherwise first name plus last name. | Keeping username login adds a second identifier and uniqueness rules absent from the assignment. Existing internal username compatibility belongs to SN-B08. |
| Registration and avatar | One registration request, with optional avatar bytes, creates the account and signs it in. Invalid avatar fails the whole submission. | A separate upload before registration needs anonymous attachment tokens and expiry; upload after registration leaves partial success for the UI to manage. Single-request registration requires coordinated failure cleanup in SN-B08/B09. |
| Sessions and logout | Independent sessions per browser/device; logout revokes the presented session only, including its retained sockets. No application-imposed idle or absolute expiry. | Single-session login silently signs out another device. Logout-all-devices is a different feature and is outside this contract. Persistent sessions increase the lifetime of a stolen token until revoked. |
| Browser persistence | Renewable 400-day persistent cookie, refreshed by successful `/users/me`; server session remains valid until logout/revocation. | A browser-session cookie loses browser-reopen guarantees. Browsers can expire or remove cookies; indefinite unattended browser persistence cannot be promised. The owner approved this limitation. |
| Phase 1 avatar access | Owner-only authenticated retrieval through a backend route. | Public or follower-visible avatars need Phase 2 profile visibility rules; this ticket does not decide those rules. |

## Common HTTP contract

- Browser URLs are relative to `/api/v1`; REST and media traverse the approved frontend proxy. Requests use `credentials: 'include'` and `Accept: application/json`. No token is returned in JSON or stored in browser Web Storage.
- JSON success is `{ "data": ... }`. JSON failure is `{ "error": { "code": "...", "message": "..." } }`, optionally with `error.fields`, a map of input name to validation code. Clients branch on codes, not human-readable messages. No password, hash, session token, filesystem path or SQL error appears in bodies or logs.
- Auth JSON responses and avatar responses, including errors, use `Cache-Control: no-store`. API errors remain JSON regardless of `Accept`; avatar success returns image bytes.
- JSON inputs must be a single object without unknown or repeated keys or trailing JSON values. Input strings must be valid UTF-8. Wrong types, unknown fields and malformed bodies return `400 BAD_REQUEST`; unsupported request content type returns `415 UNSUPPORTED_MEDIA_TYPE`.
- JSON bodies are at most 16 KiB. Registration multipart bodies are at most 6 MiB, with at most 16 KiB combined text-part content and one avatar file of at most 5 MiB. MiB means 1,048,576 bytes. Exceeding a body/file/text budget returns `413 PAYLOAD_TOO_LARGE`.

## Registration fields and validation

The same field names and validation apply to JSON and multipart text fields. Multipart sends each text field at most once; repeated or unknown parts fail with `400 BAD_REQUEST`. Omitted optional text fields, JSON `null`, or whitespace-only values normalize to `null`; multipart has no special `null` string. Required fields cannot be null or blank.

| Field | Required | Validation and normalization |
|---|---|---|
| `email` | Yes | Trim surrounding whitespace; accept a single ASCII email address, not a display name or address list. Maximum 254 bytes; local part 1–64 bytes, dot-separated nonempty atoms using letters, digits, a backtick, or `!#$%&'*+-/=?^_{\|}~`; domain has at least two dot-separated labels, each 1–63 letters/digits/hyphens with no leading/trailing hyphen. Lowercase the whole address for storage, login and uniqueness; do not rewrite dots or plus tags. |
| `password` | Yes | At least 8 Unicode code points, at most 72 UTF-8 bytes; reject NUL. Preserve exactly, including spaces; no trimming, normalization or composition requirements. |
| `first_name`, `last_name` | Yes | Trim surrounding whitespace; 1–100 Unicode code points each. Allow international names and internal spaces; reject control characters. |
| `date_of_birth` | Yes | Exact `YYYY-MM-DD`, a real Gregorian date from `0001-01-01` through today's UTC date. Reject timestamps, impossible dates and future dates. Preserve as a date, with no timezone conversion. No minimum-age rule is introduced. |
| `nickname` | No | After trimming, at most 30 Unicode code points; reject control characters. Non-unique, not a login identifier or URL key. |
| `about_me` | No | Trim surrounding whitespace; at most 1,000 Unicode code points. Plain text; allow newline/tab, reject other control characters. Render as text, not HTML. |
| `avatar` | No | A multipart file only; JSON avatar values, existing upload IDs and remote URLs are not accepted. Rules below. |

Lengths are measured after normalization except passwords, which remain untouched. Field rule failures return `400 VALIDATION_ERROR` with `fields` codes `REQUIRED`, `INVALID_EMAIL`, `INVALID_PASSWORD`, `INVALID_DATE`, `TOO_LONG` or `INVALID_TEXT`. Password byte overflow uses `INVALID_PASSWORD`. Duplicate normalized email returns `409 EMAIL_TAKEN`, with `fields.email = "EMAIL_TAKEN"`. An already-used nickname is valid. Legacy `username`, `age` and `gender` inputs are unknown fields.

The password byte ceiling follows the existing [Go bcrypt limit](https://pkg.go.dev/golang.org/x/crypto/bcrypt#GenerateFromPassword); it does not select a new hashing library or cost.

## Requests and responses

All paths in this table have prefix `/api/v1`.

| Method and path | Request | Success | Failure / state effect |
|---|---|---|---|
| `POST /users/register` | JSON fields without an avatar, or `multipart/form-data` with the same text fields and optional `avatar` file. Let the browser generate the multipart boundary. | `201`, Account as `data`, and new session cookie. | Validation/duplicate/upload failure creates no account/session/attachment. A valid existing session returns `409 ALREADY_AUTHENTICATED` without changing that session. |
| `POST /users/login` | JSON `{ "email": "alex@example.com", "password": "correct horse battery" }`. Both required; normalize email as above, never modify password. | `200`, Account as `data`, and fresh session cookie. | `401 INVALID_CREDENTIALS` for unknown email or wrong password, with the same message. Invalid input structure uses common errors. Infrastructure failure is a 5xx, not bad credentials. Failed login leaves an existing valid session intact. |
| `GET /users/me` | Session cookie; no body. | `200`, Account as `data`; refresh cookie lifetime. | Missing, unknown or revoked session: `401 UNAUTHORIZED`. Lookup failure: 5xx, never a false logout. |
| `POST /users/logout` | Session cookie; empty body. | `200`, `{ "data": { "message": "Logged out" } }`, and cookie deletion after revocation succeeds. | Already missing/unknown/revoked cookie also returns `200` with deletion: retry is safe. Revocation failure returns 5xx without clearing the cookie or claiming success. Origin checks still apply. |
| `GET /users/{id}/avatar` | Session cookie; positive numeric account ID. | `200` image bytes with verified `Content-Type` and `X-Content-Type-Options: nosniff`. | `401` without authentication; `404 NOT_FOUND` for another user's ID or no avatar. No redirect to disk/static storage. Invalid ID: `400 BAD_REQUEST`. |

Account representation is identical for registration, login and current-user lookup; IDs below are illustrative. This is the owner's account view, not a future public-profile contract:

```json
{
  "data": {
    "id": 42,
    "email": "alex@example.com",
    "first_name": "Alex",
    "last_name": "Example",
    "date_of_birth": "1998-03-14",
    "nickname": null,
    "about_me": null,
    "display_name": "Alex Example",
    "avatar_url": null
  }
}
```

Required-only registration request:

```json
{
  "email": "Alex@Example.com",
  "password": "correct horse battery",
  "first_name": "Alex",
  "last_name": "Example",
  "date_of_birth": "1998-03-14"
}
```

Full registration sends those five fields as multipart text plus `nickname = Alex E`, `about_me = I like hiking.`, and an `avatar` file part containing valid JPEG, PNG or GIF bytes. The resulting Account differs by `nickname: "Alex E"`, `about_me: "I like hiking."`, `display_name: "Alex E"`, and `avatar_url: "/api/v1/users/42/avatar"`. Removing the preview before submission means omitting the file part; an empty file is invalid, not omission. The URL belongs to the returned account and is consumed as an opaque relative URL.

Example invalid date response (`400`):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Check the highlighted fields",
    "fields": { "date_of_birth": "INVALID_DATE" }
  }
}
```

Example duplicate-email response (`409`):

```json
{
  "error": {
    "code": "EMAIL_TAKEN",
    "message": "Email is already registered",
    "fields": { "email": "EMAIL_TAKEN" }
  }
}
```

Other errors use the same envelope: `401 INVALID_CREDENTIALS` / `UNAUTHORIZED`, `403 ORIGIN_FORBIDDEN` / `CSRF_CHECK_FAILED`, `404 NOT_FOUND`, `405 METHOD_NOT_ALLOWED` (with `Allow`), `409 ALREADY_AUTHENTICATED`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 INVALID_AVATAR`, `500 INTERNAL_SERVER_ERROR`, or `503 SERVICE_UNAVAILABLE`. A 500 means an unexpected internal failure; a 503 means a known temporary dependency failure. Neither changes authenticated UI state by itself. Avatar validation errors may include `fields.avatar` with the same error code.

## Avatar ownership and failure behavior

The backend accepts a nonempty, decodable JPEG, PNG or GIF, including animated GIF, of at most 5 MiB. File content determines type; do not trust filename or declared MIME alone. If a specific declared MIME or recognized image extension contradicts decoded type, return `422 INVALID_AVATAR`; absent MIME or `application/octet-stream` is permitted. Unknown extensions do not authorize another format. Malformed/truncated/unsupported image content returns `422 INVALID_AVATAR`; request content-type errors remain 415.

Maximum width/height is 4,096 pixels each; GIF is additionally limited to 100 frames and 64 million cumulative canvas pixels across frames. Exceeding image dimensions/frame limits returns `422 INVALID_AVATAR`. These limits bound decoding work as well as upload size. The original filename never selects a storage path.

The registration request owns its new avatar; it cannot name another account, attachment ID, stored path or URL. No standalone anonymous-upload, avatar replacement/deletion or profile-edit endpoint is introduced. Retrieval is owner-only in Phase 1; user B requesting user A's avatar gets the same 404 as a missing avatar. Profile/media visibility must be revisited in Phase 2 before avatars appear on other users' profiles.

Before emitting `201`, the account, session and optional avatar must all be durable and the returned avatar URL readable. Any reported registration failure must leave no usable partial account, session or attached media; temporary bytes must never become publicly reachable. Normal failure removes temporary bytes before returning. SN-B08 must specify crash recovery and cleanup of unreachable temporary/orphan bytes before readiness; B02 deliberately does not choose transactions, directories or storage machinery.

Concurrent duplicate submissions of a previously unused email create at most one account and one attached avatar. The winner receives 201; the loser receives `409 EMAIL_TAKEN` (or `409 ALREADY_AUTHENTICATED` if sent with the winner's new cookie). A duplicate must neither reassign media nor revoke the winner's session.

A transport failure has unknown outcome: the server may have committed before the response was lost. The UI retains editable form values and selected file in memory, but never logs/persists the password or automatically resubmits registration. First retry `/users/me`: 200 identifies the signed-in account; 401 permits an explicit login attempt with the submitted credentials. After login succeeds, fetch/use the returned account and avatar; do not register again. If login also fails, let the user explicitly retry registration. A 5xx/network failure during recovery stays an unavailable/unknown state. No idempotency-key service is added.

Until SN-B09, SN-B04 must accept required-only JSON registration and optional text, and explicitly return `503 SERVICE_UNAVAILABLE` for an avatar-bearing registration before creating an account. Multipart without a file follows the same text contract. This temporary rejection is removed in B09; it is not the completed Phase 1 behavior.

## Session, cookie and origin policy

Sessions are server-owned opaque credentials. Successful login creates a new session and, if a valid previous cookie was presented, revokes that presented session after success; other devices' sessions remain valid. Registration creates a session only with successful account creation. There is no automatic logout at 12 hours or another server-side age/idle threshold. Revocation is durable across backend restarts; restoring an old cookie must not restore a revoked session. Existing account-disable behavior, if retained, denies authentication and invalidates access without requiring a new account-management API.

Cookie attributes: `session_token=<opaque>; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`, plus matching `Expires`. No `Domain` attribute. `Secure` is required for the configured HTTPS production browser origin; local HTTP development omits it. Set on successful register/login and refresh the same token/lifetime on successful `/users/me`. A cookie refresh never creates a session or reverses revocation. Logout deletes with the same name/path/security attributes, `Max-Age=0` on the wire and an expiry in the past.

Browser reopen and service/container restart must preserve login while cookie and server session remain present. Chrome caps cookie lifetime at 400 days and permits renewal on visits; user deletion, private browsing and browser eviction remain outside the app's guarantee. A user returning after browser expiry must log in again even though the unrevoked server record may still exist. This is the owner-approved interpretation, not a promise of infinite cookie retention. [Browser limit and renewal behavior](https://developer.chrome.com/blog/cookie-max-age-expires).

Logout is available from the shared shell on every supported protected route. Success clears user-specific UI state and closes local realtime resources. Other tabs using the same cookie must clear protected state when they learn of logout or receive 401; back navigation must revalidate before displaying protected content. A failed logout remains visibly failed, with a retry action. Independent device sessions stay signed in. “Global logout UI” means available everywhere, not logout-all-devices.

Server revocation must prevent new privileged HTTP/WS work under that token and close all retained sockets authenticated with it before reporting successful logout; revoking one token must not disconnect another valid session. Already committed operations are not undone. Sockets cannot bypass revocation by remaining connected. New chat features and wire-message redesign remain out of scope.

For all cookie-authenticated API writes and public register/login/logout:

- Require `X-Requested-With: XMLHttpRequest`, including multipart requests. Missing/wrong value returns `403 CSRF_CHECK_FAILED` before state changes. Do not permit cross-origin credentialed access to satisfy this header through permissive CORS.
- Verify `Origin` against the configured public frontend origin by parsed scheme, hostname and effective port. If Origin is absent, use the parsed Referer origin; reject absent both, `null`, malformed or mismatched values with `403 ORIGIN_FORBIDDEN`. Do not fall back to Referer when a present Origin is invalid.
- Compare with the configured browser origin (`FRONTEND_URL`), never the rewritten backend Host or arbitrary forwarded headers. Production allows the one origin approved by SN-A02; local Vite work configures its exact origin explicitly. Preserve these headers through the proxy. CLI/tests must supply the same origin and custom header.
- GET/HEAD do not perform business writes. `/ws` separately requires a valid cookie and matching Origin; reject missing/null/wrong Origin before upgrade. Its browser handshake cannot use the custom request header. Session lookup failures fail closed as 5xx, not successful upgrades.

This contract combines a custom header, restrictive same-origin access and origin verification; SameSite/CORS alone are not the write protection. There is no separate CSRF-token endpoint. [OWASP custom-header and origin-verification guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

For deterministic fixtures, process method/origin/custom-header checks before body parsing; authenticate protected reads next; enforce body limits/structure before field validation, avatar validation and persistence. Failure must not change account/session/media state, except successful idempotent logout. Authentication token checks needed for registration's already-authenticated response precede its body parsing.

## Fixture and verification handoff

These are required future checks, not results from B02. Dev 1 reviews the examples and matrix for A04/A05 fixtures; B04/B05/B09 exercise real APIs; A07 exercises browsers and both images. Use a fixed validation clock of `2026-09-24T12:00:00Z` in date examples.

| Case / action | Expected result | Verification owner |
|---|---|---|
| Required-only JSON request above | 201, normalized email, null optionals, fallback display name, cookie | A04 / B04 |
| Optional text populated; same nickname used by another account | 201, values round-trip; no nickname conflict | A04 / B04 |
| Optional text omitted, null or whitespace-only | 201, null fields and name fallback | A04 / B04 |
| Remove avatar preview before submitting | No file part; 201 with null avatar | A04 / B09 |
| Missing email/name/password/DOB; `2026-02-30`, `2026-09-25` or timestamp DOB | 400 with matching field code; no partial account | A04 / B04 |
| `2000-02-29`; international names; password with spaces; 73 UTF-8 password bytes | First three accepted; oversized password fails, never truncated | A04 / B04 |
| Duplicate email differing only in case/outer whitespace | 409 EMAIL_TAKEN; original account/session unchanged | A04 / B04 |
| JPEG, PNG and animated GIF registration | 201; returned URL retrieves correct type/content as owner | A04 / B09 |
| Empty/corrupt/truncated image, JPEG declared as PNG, SVG bytes | 422 INVALID_AVATAR; no account/attachment | A04 / B09 |
| File over 5 MiB, body over 6 MiB; dimensions/frame budget exceeded | 413 for byte limits; 422 for image limits; no partial writes | A04 / B09 |
| Forged `avatar_id`, `user_id` or JSON avatar URL | 400 BAD_REQUEST; no attachment reassignment | B09 |
| User B requests A's avatar; unauthenticated request | 404 for B, 401 without session; no media bytes | B09 |
| Duplicate simultaneous submit or injected media/session/commit failure | At most one successful account; failure cleanup as above; no false 201 | B04 / B05 / B09 |
| Response lost after commit; `/me` 200, or `/me` 401 then successful login | Recover existing account; no automatic registration replay | A04 / A05 / B09 |
| Valid email login; wrong password; unknown email | 200 Account; both invalid credentials cases same 401 | A05 / B05 |
| `/me` 401 versus 500/503/network failure | 401 gates protected content; outage shows retry without asserting logout | A05 / B05 |
| Issue session at T0, advance clock to T0+13h and T0+30d | `/me` 200 with original unrevoked token and renewed persistent cookie | B05 |
| Advance server clock beyond 400d with an explicitly supplied unrevoked token | Server still accepts; real browser cookie would need prior renewal or login | B05 |
| Two independent cookie jars; login twice; logout first | Second session stays valid; first token HTTP/WS rejected; existing first-session sockets closed | B05 |
| Successful logout, repeated logout, then replay old token after restart | Logout 200 both times; replay 401; no protected content via back navigation | A05 / B05 / A07 |
| Inject revocation failure or lose logout response | Server error never claims success; network result unknown; retry logout safely | A05 / B05 |
| Allowed Origin/custom header versus wrong/missing/null Origin and missing header | Valid writes accepted; forbidden requests 403 with no state change; valid Referer fallback only when Origin absent | B05 |
| Cookies on local HTTP versus production HTTPS | Correct persistence/path/HttpOnly/SameSite; Secure in production; host-only | B05 / A07 |
| Close/reopen same persistent browser profile; recreate backend/container with retained storage | `/me` and owner avatar still work; valid session retained | A07 |

## Scope and completion evidence

SN-B02 owns this interface and its review. SN-B08 chooses schema, migrations, token storage, media storage and crash cleanup; SN-B04/B05/B09 implement; SN-A04/A05 consume approved fixtures. No SQL, application code, dependencies, images, shared tooling or inherited-document cleanup is part of this change.

Owner approval and the owner's 2026-09-26 report of Dev 1's fixture confirmation are recorded above. The review is based on that explicit report, not inferred from the B02 merge or old baseline tests. No future implementation/test result is required to complete this decision ticket.

Document checks on 2026-09-24, working tree based on `525b19e`: `git diff --check` and `git diff --no-index --check /dev/null docs/social-network/auth-contract.md` passed. An inline Python check parsed all four JSON examples, resolved all 46 local Markdown links/anchors across the three changed documents, and verified tracker totals (3 done, 1 in progress, 13 not started). Application tests were not run: this decision-only change introduces no runtime behavior. The fixture matrix above remains planned verification.
