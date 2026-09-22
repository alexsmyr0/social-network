# Ticket-Writing Rules

Use these rules when creating, splitting or reviewing social-network tickets. Keep the full delivery scope in the [roadmap](roadmap.md), current status in the [tracker](ticket-tracker.md), and detailed work in [track A](track-a.md) / [track B](track-b.md).

## Keep the real-time-forum format

The [forum tracker](../ticket-tracker.md) and [track A](../track-a.md), [B](../track-b.md), [C](../track-c.md), [D](../track-d.md) established:

- A clear mission and owner for each developer track.
- Stable ticket IDs, source-requirement mapping and phase/wave ordering.
- `Depends on` and reverse `Blocks` lists, followed by `Work` and `Verification Gate` bullets.
- A central progress table; completion requires passing the ticket's gate, not merely writing code.

Retain that structure, not the old project's constraints or four-developer allocation. Use `SN-Axx` / `SN-Bxx` to avoid old-ID collisions. Link requirements directly instead of inventing unmapped source labels. Prefer the actual testing tool for each layer; browser E2E checks and unit checks are not interchangeable.

## One outcome, bounded scope

1. State one observable goal. Name what the ticket changes, its output, and the nearest excluded work.
2. Aim for one focused review/PR. Split independently verifiable outcomes: decisions versus cleanup, account API versus uploads, infrastructure versus end-to-end acceptance.
3. Target **120–220 content words**, excluding title/source/dependency metadata; review anything above 250 for a split or a linked supporting document. Use 2–4 work bullets and 2–4 gate bullets, without nested checklists.
4. Include enough contract detail to implement and verify, but put full API examples, schemas and design rationale in linked context files. Clearly label planned artifacts that do not exist yet.
5. Do not repeat repository-wide conventions, the full requirement text or implementation history in every ticket. Avoid vague goals such as “modern,” “production ready,” or “works correctly.”
6. Only ticket the agreed next phase. Future phases stay as roadmap work packages. Ticket counts are not workload estimates; do not invent tickets to equalize tracks.

## Dependencies must match actual work

- `Depends on` names **direct prerequisites** whose delivered artifacts are needed to start the scoped work; exclude transitive duplicates and mere suggested sequencing. `Blocks` must be the exact reverse relation.
- Every dependency must exist. Reject self-dependencies, duplicate IDs and cycles; topologically sort the full active ticket graph after every dependency edit.
- Audit the prose too: if a gate needs another ticket's contract, schema, executable, test suite or approval, model that prerequisite. A cycle-free table can still hide a completion deadlock.
- A producer must not wait for its consumer's implementation. Order decisions explicitly: baseline → frontend constraints → auth contract → storage design. Later incompatibilities reopen the upstream decision instead of adding a backward edge.
- State when fixtures/mocks allow independent frontend work. Separate frontend verification from the later gate that must exercise real services.
- Put owner approval and external services in explicit gates. Name external blockers and who resolves them; do not bury Git publishing/hosted CI inside an unrelated implementation task.
- Assign shared files a merge owner and record the handoff. Two tickets must not each claim ownership of the same change.

## Verification must prove the goal

- Specify the setup/action and expected result, not just “add tests” or “tests pass.” Include a normal path, meaningful failure/access-denial cases, and relevant edge or persistence behavior.
- Match the layer: repository/migration integration tests for storage; API tests for validation/auth; component tests for UI states; real browser/service tests for complete journeys; clean builds/restarts for packaging.
- Decision gates require a concrete record, alternatives and owner approval. Discovery gates require evidence and classified unknowns. Documentation gates require correct references and approved scope; no irrelevant application test runs.
- Use controlled time for session-age tests and disposable databases/fixtures. Do not confuse account age with session age, or a process restart with persistent browser login.
- Keep tests in feature tickets. Final acceptance combines the finished parts; it must not be an undeclared prerequisite for earlier infrastructure tickets.
- Record exact commands, relevant revision, results and any manual steps when executing. Discovery may report baseline failures; implementation/acceptance cannot label unexplained failed or skipped required checks as passing.

## Update and review protocol

Keep status in the tracker only: `[ ]` not started, `[-]` in progress, `[!]` blocked with reason, `[x]` gate satisfied with evidence. Reuse of old code does not automatically complete a new ticket.

When splitting, preserve the original ID for its narrowed outcome and append IDs for extracted work. Update reverse edges, tracker rows/counts, execution sequence, context and roadmap references together. Do not renumber completed tickets or treat writing a ticket as implementing it.

Before publishing a ticket update, verify: unique IDs; known dependencies; no cycles or hidden producer/consumer waits; matching reverse edges and tracker rows; phase exit reachable from all required work; explicit goals/scopes; measurable gates; valid links/anchors; concise wording. Record material audit findings separately from the tickets.

## Compact template

```markdown
## SN-Axx — Verb + concrete outcome

Source: [Relevant requirement](requirements.md#section) | Phase: 1 | Type: implementation

Goal: One observable outcome.

Scope: Included boundary; nearest excluded work and its owner/ticket.

Depends on: SN-xxx, or None

Blocks: SN-xxx, or None

External gate: Only when an approval/service outside the ticket graph is needed.

Work:

- Two to four concrete changes or deliverables.

Verification Gate:

- Two to four checks specifying method, scenario and expected outcome.
```
