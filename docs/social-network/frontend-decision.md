# Frontend Direction Decision

Decision record for [SN-A02](track-a.md#sn-a02--approve-frontend-direction). The [Zone01 requirements](requirements.md#framework) require a JavaScript framework and separate frontend/backend images. This record fixes the frontend boundary before SN-A03 scaffolds it; it does not define the auth contract owned by SN-B02 or remove inherited documentation owned by SN-A08.

## Status and review

- **Decision:** Vue 3 with Vite and Vue Router, using JavaScript ES modules and Bun for package management and frontend commands.
- **Status:** Approved by the project owner in chat on 2026-09-24.
- **Frontend evidence:** [SN-A01 baseline](frontend-baseline.md), including the current route, session, WebSocket, upload, test and reusable-module inventory.
- **Backend/transport review:** Dev 2's [SN-B01 baseline](backend-baseline.md) confirms that same-origin `/api/` and `/ws` proxying preserves cookie and WebSocket behavior, and identifies the current cross-container upload and hard-coded backend-address gaps. This is the recorded Dev 2 feasibility handoff for SN-A02.

SN-A03 and SN-B02 may consume this approved record. If either ticket finds an incompatible transport constraint, reopen SN-A02 rather than adding a reverse dependency.

## Options considered

| Option | Migration and team fit | Tooling/runtime | Decision |
|---|---|---|---|
| **Vue 3 + Vite + Vue Router** | Vue templates and component-local state are close to the inherited HTML and imperative JavaScript. The Composition API supports gradual extraction of the existing domain/API logic without requiring SSR conventions. Its conventional component model and documentation keep onboarding cost low for a two-developer team. | First-class Vite/Bun workflow, static production output, mature router and test support. No JavaScript server is needed in production. | **Chosen.** Lowest migration risk while providing an explicit application structure for the full roadmap. |
| Svelte + Vite + Svelte routing package | Concise components and a small client bundle, but the team would also have to select and standardize a third-party router. Compiler-specific reactivity adds migration and onboarding choices that do not help the existing API modules. | Good static output and Bun support; routing and conventions are less unified for this repository. | Rejected: attractive output, but more project-level choices for no demonstrated Phase 1 benefit. |
| Next.js | Strong conventions and routing, but its server/React model would introduce a Node runtime or a static-export constraint alongside the existing Go frontend server. That duplicates responsibilities and increases cookie, WebSocket and container complexity. | Broad ecosystem, but heavier build/runtime and route semantics than this client-side application needs. | Rejected: poor fit for the required two-image topology and the reusable same-origin Go proxy. |
| Mithril | Small and easy to ship, but its smaller ecosystem and lower team familiarity make the long multi-phase migration harder to support. | Minimal runtime and static delivery, but fewer conventional patterns and integrations for a growing application. | Rejected: bundle size does not outweigh maintenance and onboarding cost. |

React alone was not selected because the assignment explicitly distinguishes frameworks from libraries. Next.js was evaluated as the framework option in that ecosystem.

No repository evidence records prior team experience with Vue, Svelte, Next.js or Mithril. The comparison therefore treats familiarity as onboarding cost instead of inventing experience; the owner accepted that basis when approving Vue.

## Application and migration boundary

SN-A03 will create one Vue application rooted in `SPA/`, with Vite as the build/dev tool and Vue Router as the sole client-side router. The target source layout is organized by product domain rather than generic file type:

```text
SPA/
  src/
    app/              # bootstrap, router, session lifecycle, global shell
    api/              # shared HTTP client and response/error handling
    realtime/         # one session-owned WebSocket transport
    components/       # genuinely shared UI primitives
    features/
      auth/
      feed/
      profile/
      chat/
      notifications/
  public/             # immutable frontend-owned assets only
  dist/               # generated production bundle; never hand-edited
```

The port is vertical, not a line-for-line rewrite. Framework-neutral endpoint builders, payload shaping, session rules, domain logic, design tokens and security allowlists identified by SN-A01 may be moved with tests. String-template views, direct DOM mutation, the Proxy store and document-event rendering bindings are replaced by Vue components, composables and reactive state. There will be no second client router, hybrid DOM ownership or production dependency on the old `SPA/main.js` bootstrap.

Phase 1 implements `/login`, `/register` and the authenticated `/` shell. The inherited forum-only routes `/posts/:id`, `/create-post`, `/edit-post/:id`, `/activity`, `/profile/:id` and the aliases `/view-post/:id` and `/post/:id` are intentionally retired from the Phase 1 router until their corresponding social-network features are ported in later roadmap phases. A direct visit must resolve through a named not-found/migration state with a safe link back to `/`; it must not silently render stale forum behavior or rewrite to a different legacy URL. Route names may be reintroduced only with their feature implementation and access tests.

## Browser, proxy and container boundary

Production exposes exactly one browser origin: the frontend container. It serves the built Vue assets and SPA history fallback, and reverse-proxies these backend-owned transports:

- `/api/` for REST and media endpoints;
- `/ws` for the authenticated WebSocket upgrade.

The browser uses relative URLs, `credentials: 'include'`, and a WebSocket URL derived from `window.location`; it never addresses the backend container directly. This preserves host-only session cookies, avoids production CORS as an application dependency, and keeps the current Content Security Policy's `connect-src 'self'` boundary. The backend remains independently reachable on its container network port for the frontend proxy and automated health checks, not as a second public browser origin.

Local production-like development uses the same topology on `http://localhost:3000`, proxying to the backend on `:8080`. Vite's development server may proxy the same paths during component work, but that is a developer convenience, not a different browser contract. The Go frontend proxy's backend target must become configuration-driven for containers; `localhost:8080` is not valid when the services run in separate containers.

The frontend image will build the Vue bundle and serve it with the Go frontend binary. SN-A06 owns that image; SN-B06 owns the backend image. SN-B07 owns shared orchestration. SN-A02 does not edit their Dockerfiles or shared Make targets.

## Upload and static-asset boundary

Frontend-owned build assets and backend-owned user media are separate:

- Vite emits hashed application assets, served by the frontend container.
- The backend validates, stores and retrieves avatars and other user uploads from its persistent storage.
- Browser upload and retrieval use same-origin backend routes through the frontend proxy. Containers do not share the repository's `web/static/uploads` directory and the frontend image does not own uploaded bytes.


## Approved documentation dispositions

The owner also approved the SN-A01 documentation dispositions as the input to SN-A08:

- Keep the active `docs/social-network/` set and update its status references as decisions land.
- Keep the inherited forum requirements, audit, PRD, SDS and delivery records as historical evidence until SN-A08 classifies and relinks them; they are not social-network authority.
- Rewrite the root README and architecture document in SN-A08 to describe the social-network and approved Vue boundary once the scaffold makes those statements true.
- Archive or rewrite obsolete forum PR prompts, scratch plans and dead `docs/pr-message/` references in SN-A08 after checking whether any workflow still consumes them.

A02 authorizes these dispositions but deletes or broadly rewrites no inherited document.

SN-B02 defines the avatar request/response and authorization contract, and SN-B08/B09 define its durable mapping and storage lifecycle. Existing `/static/uploads/...` values are migration evidence, not the approved avatar contract. If compatibility is temporarily required, it must still be proxied to a backend-owned handler; it must not restore frontend filesystem ownership. Media authorization must be decided per feature before private profile, post or chat media is exposed.

## Constraints for dependent tickets

SN-A03 must prove that a direct load of each Phase 1 route receives the Vue shell, a missing JavaScript asset returns a real 404, `/api/` keeps cookies and status codes, and `/ws` preserves upgrade semantics. It must keep a single session bootstrap and a single session-owned WebSocket connection; feature components consume reactive events rather than opening their own sockets.

SN-B02 may assume a same-origin browser contract with cookie authentication, relative API/media URLs and no browser-visible backend origin. It must not assume a final media URL shape from the inherited `/static/uploads/` implementation. Session, CSRF/write-origin, avatar validation and error-envelope behavior remain SN-B02 decisions.

No decision here claims that the inherited forum routes or APIs satisfy the social-network requirements. Documentation cleanup remains SN-A08, and application/container implementation remains in their named dependent tickets.
