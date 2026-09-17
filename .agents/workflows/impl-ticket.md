---
description: Implement a specific feature for the Real-Time Forum project.
---

# Premium Implementation Instruction: {Ticket}

You are an expert Senior Full-Stack Engineer tasked with implementing a specific feature for the **Real-Time Forum** project. Your goal is to produce state-of-the-art, high-performance, and maintainable code that strictly adheres to the project's architectural standards.

## 1. Primary Directives

1.  **Read the Source of Truth**: Before starting, you **must** read:
    -   `AGENTS.md`: For architecture, conventions, and allowed dependencies.
    -   `docs/ticket-tracker.md`: To locate the ticket and its dependencies.
    -   `docs/track-{a,b,c,d}.md`: For the specific ticket definition and verification gate.
2.  **ES2026+ Vanilla JS**: No frameworks. Use modern ES2026+ features.
3.  **Platform First**: Prioritize native browser APIs over any third-party logic.
4.  **Verification Gate**: Your work is not finished until the ticket's verification gate is fully satisfied and verified via tests.

---

## 2. Technical Standards (ES2026+ & Modern Patterns)

### 2.1 Modern Language Features
- **Temporal API**: Use `Temporal` for all date/time handling (e.g., `Temporal.Now.zonedDateTimeISO()`). Never use `new Date()`.
- **Resource Management**: Use the `using` keyword for automatic cleanup of resources (WebSocket connections, event controllers, timers) that implement `[Symbol.dispose]`.
- **Immutable Updates**: Use array-by-copy methods (`toSorted`, `toReversed`, `with`) to maintain clean state transitions.
- **Async Handling**: Use `Array.fromAsync()` and `Promise.try()` to handle complex asynchronous flows gracefully.

### 2.2 Vanilla SPA Patterns
- **Proxy-Based Reactivity**: Implement state management using the native `Proxy` API to intercept changes and trigger surgical DOM updates.
- **Clean Architecture**: Decouple business logic (Entities/Use Cases) from the UI (Components) and Infrastructure (API Clients). Keep the "core" logic pure JS.
- **Event Delegation**: Attach events to parent containers. Use `event.target` and `data-*` attributes to resolve actions.
- **History API**: Use `navigation` API or `history.pushState` for client-side routing.

### 2.3 Performance & A11y
- **Batch DOM Operations**: Use `DocumentFragment` for bulk insertions. Always batch DOM reads and writes separately to avoid layout thrashing.
- **INP Optimization**: Ensure Interaction to Next Paint (INP) is minimized by offloading heavy work to `requestIdleCallback` or Web Workers.
- **Semantic HTML**: Use `main`, `section`, `article`, and `aria-*` attributes to ensure the application is fully accessible.

---

## 3. Workflow Implementation

### Step 1: Analysis & Schema
- Check `docs/SDS.md` for the data model and API contracts relevant to this ticket.
- If backend changes are required, update `internal/db/` and `internal/handlers/` first.
- Ensure all Go code follows the layered approach (no SQL in handlers).

### Step 2: Implementation
- Maintain **Single HTML File** integrity. All new UI must be injected/rendered via JS.
- Use **Vanilla CSS** in `web/static/css/`. Leverage CSS Variables and Flexbox/Grid for layouts.
- Implement UI state in a reactive store module.

### Parallel Steps 3 & 4: Post-Implementation Tasks
> [!IMPORTANT]
> Once Step 2 has finished, **Step 3 and Step 4 must be executed in parallel from different agents with new contexts.**

#### Step 3: Testing, QA & Verification (Agent A)
- **Run QA Tests**: Execute `make test` (includes Go, Vitest, and Playwright E2E) and `make verify-infra`. Verify all gates are met. If tests fail, you **must** iterate until they pass.
- **Bug Workflow**: If you encounter a bug during implementation:
  1. Create a minimal test case that reproduces the bug.
  2. Implement the fix.
  3. Verify the reproduction test and all integration tests pass.
- **Final Polish**: Use **Biome** for linting and formatting (`biome check --apply .`).

#### Step 4: Documentation & Handover (Agent B)
- **PR Message**: Create a detailed PR message summarizing your changes, technical decisions, and verification results.
- **Update ticket-tracker.md**: Update the status of ticket you just finished implementing to `Done`, put x in status.
- **Template Compliance**: You **must** use [docs/pr-message/pr-template.md](file:///home/ertval/code/zone-modules/real-time-forum/docs/pr-message/pr-template.md) as the blueprint for your message. Ensure the Ticket Name is in the header and all verification results (automated and manual) are documented.
- **Storage**: Save the PR message as a new markdown file in `docs/pr-message/` using the ticket ID as the filename and a short description of the ticket (e.g., `docs/pr-message/A01-[ShortDescription]-pr.md`).

---

## 5. Specific Ticket Context: {Ticket}

> [!IMPORTANT]
> Insert the full ticket description and verification gate from the track file here before executing.

**Begin implementation now.** Focus on clean abstractions and robust error handling.