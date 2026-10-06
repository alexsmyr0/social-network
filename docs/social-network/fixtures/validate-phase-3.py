#!/usr/bin/env python3
"""Validate the B14 handoff artifacts, not the running application."""

import copy
import itertools
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / "docs/social-network"
PACK = json.loads((DOCS / "fixtures/phase-3-contract.json").read_text())
MAX_ID = 9007199254740991
POST_FIELDS = {
    "id", "author_id", "author", "title", "body", "image_url", "status",
    "audience", "version", "categories", "created_at", "updated_at",
    "likes", "dislikes", "my_reaction",
}
COMMENT_FIELDS = {
    "id", "post_id", "user_id", "username", "parent_comment_id", "body",
    "image_url", "version", "created_at", "updated_at", "likes", "dislikes",
    "my_reaction",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def merge(base, patch):
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def can_read(state, viewer):
    """Independent policy oracle for the fixed published-post matrix."""
    p = state["posts"]["101"]
    u = state["users"]
    if viewer is None or not u[str(viewer)]["is_active"] or not u["42"]["is_active"]:
        return False
    if viewer == 42:
        return True
    if p["status"] != "published":
        return False
    follows = [f for f in state["follows"].values()
               if f["follower_id"] == viewer and f["followed_id"] == 42
               and f["state"] == "accepted"]
    if u["42"]["visibility"] == "private" and not follows:
        return False
    audience = p["audience"]
    if audience == "public":
        return True
    if audience == "followers":
        return bool(follows)
    return any(f["id"] in p["selected_follow_ids"] for f in follows)


def check_exchange(exchange, viewer, name):
    request = exchange["request"]
    response = exchange["response"]
    require(request["method"] in {"GET", "POST", "PATCH", "PUT", "DELETE"}, name)
    require(request["path"].startswith(("/api/v1/", "/static/")), name)
    status = response["status"]
    require(status in {200, 201, 204, 400, 401, 403, 404, 405, 409, 413, 415, 422, 500, 503}, name)
    require(response["headers"].get("Cache-Control") == "no-store", name)
    require(sum(k in response for k in ("body", "bytes_fixture", "empty_body")) == 1,
            f"{name}: response must specify one body representation")
    if status == 204:
        require(response.get("empty_body") is True, name)
    if "bytes_fixture" in response:
        require(status == 200 and (ROOT / response["bytes_fixture"]).is_file(), name)
        require(response["headers"].get("X-Content-Type-Options") == "nosniff", name)
    body = response.get("body", {})
    if status >= 400:
        require(set(body) == {"error"}, f"{name}: error must not disclose data")
        require(body["error"].get("code") and body["error"].get("message"), name)
        if status == 409:
            require(body["error"] == {
                "code": "STALE_CONTENT",
                "message": "Content changed; refresh and retry",
            }, name)
    elif "body" in response:
        require("data" in body and "error" not in body, name)
    for obj in walk(body):
        require(not ({"password_hash", "session_token", "email", "selected_follow_ids"} & obj.keys()),
                f"{name}: secret/internal field in response")
        if "author_id" in obj and "status" in obj:
            extra = {"selected_follower_ids"} if obj["author_id"] == viewer else set()
            require(set(obj) == POST_FIELDS | extra, f"{name}: Post schema/redaction mismatch")
            require(obj["audience"] in {"public", "followers", "selected"}, name)
            require(obj["title"] is None or isinstance(obj["title"], str), name)
            require(0 < obj["version"] <= MAX_ID, name)
            if extra:
                selected = obj["selected_follower_ids"]
                require(selected == sorted(set(selected)), name)
                require(obj["audience"] == "selected" or not selected, name)
        if "parent_comment_id" in obj and "username" in obj:
            require(set(obj) == COMMENT_FIELDS or set(obj) == COMMENT_FIELDS | {"post"},
                    f"{name}: Comment schema mismatch")
        if "total_pages" in obj:
            require(set(obj) == {"page", "per_page", "total", "total_pages"}, name)
            require(1 <= obj["page"] <= 1000000 and 1 <= obj["per_page"] <= 50, name)
            require(obj["total_pages"] == (obj["total"] + obj["per_page"] - 1) // obj["per_page"], name)
        if obj.get("access") == "teaser":
            require(set(obj) == {"id", "display_name", "access", "relationship"}, name)
    if status == 405:
        require(response["headers"].get("Allow"), name)
    files = request.get("files", {})
    for fixture in files.values():
        if isinstance(fixture, str):
            require((ROOT / fixture).is_file(), f"{name}: missing upload fixture")


def check_fixtures():
    require(PACK["schema_version"] == 1, "Unknown fixture schema")
    require(PACK["review_status"] == "draft; owner approval pending" or
            re.fullmatch(r"owner-approved \d{4}-\d{2}-\d{2}; fixture completeness/consistency checked", PACK["review_status"]),
            "Approval metadata mismatch")
    cases = PACK["cases"]
    require(len(cases) == len({c["name"] for c in cases}), "Duplicate case name")
    matrix = {}
    tags = set()
    for case in cases:
        name = case["name"]
        check_exchange(case, case["viewer_id"], name)
        tags.update(case["tags"])
        if case["response"]["status"] >= 400:
            require(case.get("unchanged") is True and case.get("signals") == [],
                    f"{name}: denial/failure needs unchanged-state and silence")
        for signal in case.get("signals", []):
            require(set(signal) == {"type", "recipients"}, f"{name}: payload leak")
            require(signal["type"] in {"social.invalidate", "notification.new"}, name)
        if "matrix" in case:
            m = case["matrix"]
            state = merge(PACK["state"], case["given"])
            allowed = can_read(state, case["viewer_id"])
            require(m["allowed"] == allowed, f"{name}: access matrix contradicts policy")
            key = (m["profile"], m["audience"], m["role"])
            surface = next(t for t in case["tags"] if t in {"detail", "thread", "media", "feed"})
            require(surface not in matrix.setdefault(key, set()), name)
            matrix[key].add(surface)
            if surface == "feed":
                data = case["response"]["body"]["data"]
                require(len(data) == int(allowed), f"{name}: denied feed/count leak")
                require(case["response"]["body"]["meta"]["pagination"]["total"] == int(allowed), name)
            else:
                require(case["response"]["status"] == (200 if allowed else 404), name)
    expected = set(itertools.product(["public", "private"], ["public", "followers", "selected"],
                                     ["outsider", "follower", "selected"]))
    require(set(matrix) == expected and all(s == {"detail", "thread", "media", "feed"}
                                           for s in matrix.values()), "Missing matrix cell/surface")
    required_tags = {"owner", "owner-status", "auth", "inactive", "pending", "create", "draft",
                     "publication", "audience-edit", "selection", "follow-transition",
                     "privacy-transition", "comments", "nested", "reaction", "delete", "edit",
                     "activity", "profile", "categories", "navigation", "paging", "filter",
                     "redaction", "notice", "media-validation", "media-alias", "replacement",
                     "stale", "race", "failure", "recovery", "transport", "noop", "self"}
    require(required_tags <= tags, f"Missing coverage: {required_tags - tags}")
    directions = {c["name"] for c in cases if "audience-edit" in c["tags"]}
    require(directions == {f"audience-{a}-to-{b}" for a, b in itertools.permutations(
        ["public", "followers", "selected"], 2)}, "Missing audience-edit direction")
    sequence = PACK["sequences"][0]
    steps = sequence["steps"]
    require(len(steps) == 6, "Incomplete unfollow/refollow sequence")
    for step in steps:
        check_exchange(step, step["viewer_id"], sequence["name"])
    require(steps[0]["expect_state"]["posts"]["101"]["selected_follow_ids"] == [], "No prune")
    require(steps[2]["response"]["body"]["data"]["id"] != 71, "Refollow reused identity")
    require(steps[3]["response"]["status"] == 404, "Refollow restored grant")
    require(steps[4]["expect_state"]["posts"]["101"]["selected_follow_ids"] == [74], "Wrong reselect")
    require(steps[5]["response"]["status"] == 200, "Explicit reselection failed")
    print(f"{len(cases)} HTTP fixtures; 18 matrix cells × 4 surfaces; 6-step follow sequence valid")


def anchor(text):
    return re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")


def check_docs_and_tracker():
    files = [DOCS / name for name in ["content-contract.md", "phase-3-data-plan.md", "CONTEXT.md",
                                      "ticket-tracker.md", "track-a.md", "track-b.md"]]
    links = 0
    for path in files:
        text = path.read_text()
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if "://" in target:
                continue
            name, _, fragment = target.partition("#")
            dest = path.parent / name if name else path
            require(dest.is_file(), f"{path.name}: missing {target}")
            if fragment:
                headings = re.findall(r"^#{1,6}\s+(.+)$", dest.read_text(), re.M)
                require(fragment in {anchor(h) for h in headings}, f"{path.name}: missing anchor {target}")
            links += 1
    tickets = {}
    for track in ["a", "b"]:
        sections = re.split(r"^## (SN-[AB]\d+) — .+$", (DOCS / f"track-{track}.md").read_text(), flags=re.M)
        for ticket, body in zip(sections[1::2], sections[2::2]):
            require(ticket not in tickets, f"Duplicate ticket {ticket}")
            deps = re.search(r"^Depends on: (.+)$", body, re.M).group(1)
            blocks = re.search(r"^Blocks: (.+)$", body, re.M).group(1)
            tickets[ticket] = (set(re.findall(r"SN-[AB]\d+", deps)), set(re.findall(r"SN-[AB]\d+", blocks)))
    require(len(tickets) == 36, "Ticket count changed")
    visited, active = set(), set()

    def visit(ticket):
        require(ticket not in active, f"Dependency cycle at {ticket}")
        if ticket in visited:
            return
        active.add(ticket)
        for dependency in tickets[ticket][0]:
            require(dependency in tickets, f"Unknown dependency {dependency}")
            require(ticket in tickets[dependency][1], f"Missing reverse edge {ticket}/{dependency}")
            visit(dependency)
        for blocked in tickets[ticket][1]:
            require(blocked in tickets and ticket in tickets[blocked][0], f"Wrong Blocks {ticket}/{blocked}")
        active.remove(ticket)
        visited.add(ticket)

    for ticket in tickets:
        visit(ticket)
    tracker = (DOCS / "ticket-tracker.md").read_text()
    rows = re.findall(r"^\| \[(x| |-|!)\] \| \[(SN-[AB]\d+)\].*$", tracker, re.M)
    require(len(rows) == len({t for _, t in rows}) == 36, "Tracker duplicate/missing row")
    statuses = {ticket: status for status, ticket in rows}
    require(statuses["SN-A10"] == statuses["SN-A11"] == statuses["SN-B13"] == "x", "Prerequisite incomplete")
    approved = PACK["review_status"].startswith("owner-approved ")
    require(statuses["SN-B14"] == ("x" if approved else "-"), "B14 status/approval mismatch")
    for line in tracker.splitlines():
        match = re.match(r"\| \[[x !-]\] \| \[(SN-[AB]\d+)\]", line)
        if match:
            cells = line.split("|")
            ticket = match.group(1)
            require(set(re.findall(r"SN-[AB]\d+", cells[4])) == tickets[ticket][0], f"Tracker deps {ticket}")
            require(set(re.findall(r"SN-[AB]\d+", cells[5])) == tickets[ticket][1], f"Tracker blocks {ticket}")
    counts = {s: sum(value == s for value in statuses.values()) for s in ["x", "-", "!", " "]}
    summary = (f"Done: {counts['x']}. In progress: {counts['-']}. "
               f"Blocked: {counts['!']}. Not started: {counts[' ']}.")
    require(summary in tracker, "Summary mismatch")
    # Markdown JSON examples must agree with the fixture wire schema.
    contract = (DOCS / "content-contract.md").read_text()
    for raw in re.findall(r"```json\n(.*?)\n```", contract, re.S):
        json.loads(raw)
    require(("owner-approved contract and fixture handoff" if approved else "owner approval pending")
            in contract.lower(), "Contract approval not explicit")
    plan = (DOCS / "phase-3-data-plan.md").read_text()
    for invariant in ["follow_id", "sqlite_sequence", "foreign_key_check", "000005", "pending DMs"]:
        require(invariant in plan, f"Data plan omits {invariant}")
    print(f"{links} local links/anchors; 36-ticket graph/reverse edges/status counts; JSON examples valid")


if __name__ == "__main__":
    check_fixtures()
    check_docs_and_tracker()
