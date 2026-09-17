---
name: fix-gitea-issue
description: Automated loop to retrieve, group, resolve, and verify Gitea issues assigned to Track A (ertval) following TDD.
---

# Fix Gitea Issue Automator

You are an automated agent responsible for processing, resolving, and verifying Gitea issues assigned to **Track A (ekaramet) — Ertval Karameta** in the `real-time-forum` repository. You must strictly follow the development workflows, architectural constraints, and validation standards of the project.

## Workflow Goal
Your objective is to identify assigned issues in Gitea, group them in batches of three small issues, resolve them using Test-Driven Development (TDD), audit the changes, open a PR with proper linkages, and ensure that both local and remote CI gates pass completely before declaring success.

---

## Step-by-Step Instructions

### Step 1: Issue Discovery and Scoping
1. Use the Gitea CLI (`tea`) to retrieve all open issues assigned to `ekaramet`:
   ```bash
   tea issues list --assignee ekaramet --state open --repo asmyrogl/real-time-forum --fields index,title,state --output simple
   ```
2. **Double-check assignment**: For each issue from the list, run:
   ```bash
   tea issues list --repo asmyrogl/real-time-forum --fields index,assignees --output simple | grep "^<issue-number> "
   ```
   and verify the assignee field contains `Erti Karameta`.
3. Filter the retrieved issues to identify those that have no open PRs already linked to them. IF THERE ARE open PRs referencing these issues skip them and select others.
4. Group exactly **3 small/related issues** into a single batch. If fewer than 3 issues remain, group the remaining ones together.
5. For the selected batch of issues:
   - Read their descriptions, requirements, and comments in detail.
   - Run:
     ```bash
     tea issues <issue-number> --repo asmyrogl/real-time-forum
     ```
     for each issue to extract precise acceptance criteria and requirements.

### Step 2: Branch Setup
1. Define a branch name that reflects the track and issues being resolved, adhering to the convention in [AGENTS.md](../../AGENTS.md).
   - Format: `ekaramet/A-<NN>-<short-description>` (where `<NN>` is the main ticket or issue number being addressed, or a batch ID).
2. Create and switch to the new branch:
   ```bash
   git checkout -b <branch-name>
   ```

### Step 3: Test-Driven Development (TDD) Implementation
You must strictly follow the bug-fix workflow from [AGENTS.md](../../AGENTS.md):
1. **Write Failing Tests First (Reproduce)**: For each issue in the batch, write one or more unit, integration, or E2E tests (using Vitest or Playwright) that reproduce the issue or check the new requirement. Run the test suite and confirm that these new tests fail.
2. **Implement Minimal Fix**: Edit the source files to resolve the issue with the minimal amount of code possible, ensuring the reproduction test now passes. Adhere to:
   - **AGENTS.md architecture rules** — layered backend (`db/` no HTTP, `handlers/` no SQL), session-cookie auth, vanilla JS SPA with clean vertical slices.
   - **Forbidden** — no frontend frameworks (React/Vue/Angular), no additional Go deps beyond the allowed list, no guest access, no canvas/WebGL.
   - **Safe DOM sinks** — use `textContent`, explicit attribute APIs, `createElement`/`appendChild`. NO `innerHTML`, `outerHTML`, or `document.write`.
   - **Common Pitfalls** — avoid all common pitfalls listed in the guidelines below.
3. **Verify and Clean**:
   - Run the full test suite (`make test` and `bun test` / `vitest`) to ensure no regressions. `make test` must pass after every change.
   - Fix any linting or formatting issues using Biome (`bun x biome`).
4. **Iterate**: Repeat this cycle for each of the 3 issues until all of them are resolved and all tests pass.

### Step 4: Local PR Audit
Before creating a PR, you must run the PR audit workflow to ensure compliance. THIS IS A MUST:
1. Run the `/pr-audit` workflow (located at `.github/prompts/pr-audit.prompt.md`) in your terminal or trigger the subagent if applicable.
2. Inspect the audit report generated at `docs/audit-reports/pr-audit-<branch-name>.md`.
3. If any checks or requirements fail, fix them on your branch and rerun the audit. Do not proceed until the PR audit passes.

### Step 5: Local Validation
The task is not complete until local policy gates pass.
1. **Run Validation in a New Context**:
   - If possible, spawn a new tool-use context or subagent to perform clean, isolated checks.
   - Run the local policy gate check:
     ```bash
     make test
     ```
2. **Handle Failures**:
   - If the local `make test` gate fails:
     - Retrieve the failure output.
     - Diagnose the failure.
     - Implement the necessary fixes on your branch.
     - Commit and push the updates.
     - Restart this verification loop.
   - Loop this step until all local checks pass completely.

### Step 6: Pull Request Creation
Once local checks and the PR audit pass:
1. Format a conventional commit message with ticket IDs:
   ```bash
   git commit -a -m "feat(A-<NN>): resolve issues #X, #Y, #Z"
   ```
2. Push the branch to the Gitea remote. In this repository the Gitea
   instance is configured as the `origin` remote, so push there:
   ```bash
   git push -u origin <branch-name>
   ```
3. Generate a PR description that strictly follows the template at
   [.github/pull_request_template.md]. Save it to the [pr message folder](../../docs/pr-message).
   - Clearly state the component changes and rationale.
   - **Link every issue being resolved** using Gitea closing keywords so the
     PR is automatically connected to — and closed by — those issues. Put one
     closing keyword per issue, e.g.:
     ```
     Closes #X
     Closes #Y
     Closes #Z
     ```
     Gitea auto-links and closes any issue referenced with `Closes` / `Fixes` /
     `Resolves` in the PR body, so **all three issue numbers MUST appear in
     the body**.
4. Create the PR using the Gitea CLI (`tea`):
   ```bash
   tea pulls create \
     --title "Track A: Resolve issues #X, #Y, #Z" \
     --description "$(cat <path-to-pr-body-markdown>)" \
     --head <branch-name> \
     --base main \
     --repo asmyrogl/real-time-forum
   # Capture the new PR index reliably via its head branch:
   PR_INDEX=$(tea pulls list --repo asmyrogl/real-time-forum \
     --head <branch-name> --state open \
     --output simple --fields index | head -1)
   echo "Created PR #$PR_INDEX"
   ```
5. **Assign all available devs as reviewers** so the PR gets cross-team
   review. Every developer login appears as an `assignees` **login array** in
   the per-issue JSON (the `index,assignees` *list* view collapses it to a
   display-name string, so fetch each issue individually). Collect and dedupe
   them, then **drop the PR author** — Gitea rejects a PR's own poster as
   reviewer ("poster of pr can't be reviewer") — and request review:
   ```bash
   DEVS=$(for n in $(tea issues list --repo asmyrogl/real-time-forum \
       --state open --output simple --fields index 2>/dev/null); do
     tea issues "$n" --repo asmyrogl/real-time-forum \
       --output json 2>/dev/null | jq -r '.assignees[]?'
   done | sort -u | paste -sd, -)

   ME=$(tea whoami 2>/dev/null | grep -oE '# [a-zA-Z0-9_-]+' | cut -d' ' -f2)
   DEVS=$(echo "$DEVS" | tr ',' '\n' | grep -vx "$ME" | paste -sd, -)
 
   tea pulls edit "$PR_INDEX" --add-reviewers "$DEVS" \
     --repo asmyrogl/real-time-forum
   ```
6. **Verify the linkage** before finishing: re-read the created PR
   (`tea pulls $PR_INDEX --repo asmyrogl/real-time-forum`) and confirm each
   `#X` / `#Y` / `#Z` appears in the body and that the linked-issues
   section lists them. Gitea will auto-close them when the PR merges.

---

## Working on Tickets
1. **Check `docs/ticket-tracker.md`** for the current implementation wave and which tickets are unblocked.
2. **Read the full ticket definition** in the relevant track file (`docs/track-{a,b,c,d}.md`).
3. **Check dependencies** — don't start a ticket until all its `Depends on` tickets are `[x]`.
4. **Satisfy the verification gate** — each ticket's gate defines "done".
5. **Update the tracker** — mark `[-]` when in progress, `[x]` when the gate is satisfied.
6. Run tests — `make test` must pass after every change.

## Bug Workflow
If you encounter or identify a bug during development:
1. **Reproduce**: Create a minimal test case (in Go or Vitest) that isolates and reproduces the bug.
2. **Fix**: Implement the fix while ensuring the reproduction test now passes.
3. **Verify**: Run the full test suite (`make test` and `bun test` / `vitest`) to ensure no regressions.
4. **Clean**: Fix any linting or formatting issues using Biome (`bun x biome`).

## Common Pitfalls
- **Don't serve multiple HTML templates** — the app is a SPA. One HTML shell, all navigation in JS.
- **Don't allow guest access** — all forum content requires authenticated session.
- **Don't render comments in the feed** — comments load only on post detail.
- **Don't send DMs to offline users** — the backend must reject `dm.send` to offline recipients.
- **Don't use polling for chat** — use WebSocket for presence and DMs. Polling is only for legacy notifications.
- **Don't add npm/node dependencies** — the frontend is vanilla JS served by the Go frontend server.
- **Don't use external CSS frameworks** — vanilla CSS only.
- **Throttle/debounce scroll events** — the history pagination scroll must not spam the API.

---

## Definition of Done
You may only conclude your execution when:
1. All 3 grouped issues are marked as resolved in code and verified by passing tests.
2. A PR is created, **linked to (and set to close) all the issues** via closing keywords in its body, and **all available devs are assigned as reviewers**.
3. The local `make test` command executes with an exit code of `0`.