#!/usr/bin/env python3
"""Validate the B17 handoff artifacts, not the running application.

The checks re-derive group access and the membership state machine with an
independent reference model, then compare every fixture, sequence and race
against it. They prove the contract/fixture pack is internally consistent; they
do not exercise the Go API, migrations, browser or sockets.
"""

import copy
import itertools
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / "docs/social-network"
PACK = json.loads((DOCS / "fixtures/phase-4-contract.json").read_text())
MAX_ID = 9007199254740991
ALL = "all_authenticated"
ROLES = ["creator", "member", "invitee", "requester", "follower", "departed-author", "departed-member", "outsider"]
ROLE_USER = {"creator": 42, "member": 7, "invitee": 8, "requester": 9, "follower": 10,
             "departed-author": 11, "departed-member": 12, "outsider": 99}
POST_FIELDS = {
    "id", "author_id", "author", "title", "body", "image_url", "status", "audience", "version",
    "categories", "created_at", "updated_at", "likes", "dislikes", "my_reaction", "group",
}
COMMENT_FIELDS = {
    "id", "post_id", "user_id", "username", "parent_comment_id", "body", "image_url", "version",
    "created_at", "updated_at", "likes", "dislikes", "my_reaction",
}
GROUP_FIELDS = {"id", "title", "description", "created_at", "creator", "viewer"}
SUMMARY_FIELDS = {"id", "title", "description", "creator"}
MEMBERSHIP_FIELDS = {"id", "group_id", "user_id", "role", "joined_at"}
PINNED = {
    "STALE_INVITATION": (409, "Invitation changed; refresh before acting"),
    "STALE_JOIN_REQUEST": (409, "Request changed; refresh before acting"),
    "STALE_MEMBERSHIP": (409, "Membership changed; refresh before acting"),
    "STALE_CONTENT": (409, "Content changed; refresh and retry"),
    "ALREADY_MEMBER": (409, "Already a member"),
    "CREATOR_CANNOT_LEAVE": (409, "The creator cannot leave the group"),
    "SELF_INVITE": (400, "Cannot invite yourself"),
}
ERROR_CODES = {
    "UNAUTHORIZED", "ORIGIN_FORBIDDEN", "CSRF_CHECK_FAILED", "BAD_REQUEST", "VALIDATION_ERROR",
    "NOT_FOUND", "METHOD_NOT_ALLOWED", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE",
    "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "INVALID_IMAGE", *PINNED,
}
FIELD_CODES = {
    "REQUIRED", "TOO_LONG", "INVALID_TEXT", "INVALID_ID", "INVALID_CHOICE", "GROUP_SCOPE", "IMMUTABLE",
    "CONTENT_REQUIRED", "SELF_INVITE",
}
NOTICE_STATES = {
    "group_invitation": {"pending", "accepted", "refused", "cancelled", "superseded"},
    "group_join_request": {"pending", "accepted", "refused", "superseded"},
}
TABLES = ["groups", "group_memberships", "group_invitations", "group_join_requests", "notifications",
          "posts", "comments", "reactions", "media"]


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


def rows(S, table):
    return list(S[table].values())


def is_active(S, uid):
    user = S["users"].get(str(uid))
    return bool(user and user["is_active"])


def membership(S, gid, uid):
    return next((m for m in rows(S, "group_memberships")
                 if m["group_id"] == gid and m["user_id"] == uid and is_active(S, uid)), None)


def raw_member(S, gid, uid):
    return any(m["group_id"] == gid and m["user_id"] == uid for m in rows(S, "group_memberships"))


def active_members(S, gid):
    return {m["user_id"] for m in rows(S, "group_memberships")
            if m["group_id"] == gid and is_active(S, m["user_id"])}


def follows(S, follower, followed):
    return any(f["follower_id"] == follower and f["followed_id"] == followed and f["state"] == "accepted"
               for f in rows(S, "follows"))


# ----------------------------------------------------------------------------
# Independent policy oracle
# ----------------------------------------------------------------------------
def can_read_post(S, viewer, pid):
    post = S["posts"].get(str(pid))
    if post is None or viewer is None or not is_active(S, viewer) or not is_active(S, post["author_id"]):
        return False
    if post["group_id"] is not None:
        # Group scope: current membership only; drafts only for their author.
        # Profile visibility, follows and personal audiences never participate.
        if membership(S, post["group_id"], viewer) is None:
            return False
        return post["status"] == "published" or post["author_id"] == viewer
    if viewer == post["author_id"]:
        return True
    if post["status"] != "published":
        return False
    following = follows(S, viewer, post["author_id"])
    if S["users"][str(post["author_id"])]["visibility"] == "private" and not following:
        return False
    if post["audience"] == "public":
        return True
    if post["audience"] == "followers":
        return following
    return any(f["follower_id"] == viewer and f["id"] in post.get("selected_follow_ids", [])
               for f in rows(S, "follows"))


def visible_published(S, viewer):
    items = [p for p in rows(S, "posts") if p["status"] == "published" and can_read_post(S, viewer, p["id"])]
    return sorted(items, key=lambda p: (p["created_at"], p["id"]), reverse=True)


# ----------------------------------------------------------------------------
# Independent membership state machine
# ----------------------------------------------------------------------------
class Result:
    def __init__(self, state, status, code=None, signals=None):
        self.state, self.status, self.code, self.signals = state, status, code, signals or []


def alloc(S, table):
    number = S["next_ids"][table]
    require(number <= MAX_ID, "ID ceiling")
    S["next_ids"][table] = number + 1
    return number


def group_notice(S, kind, entry_id):
    return next((n for n in rows(S, "notifications") if n["type"] == kind and n["entry_id"] == entry_id), None)


def resolve_notice(S, kind, entry_id, state, named):
    notice = group_notice(S, kind, entry_id)
    if notice is not None:
        notice["state"], notice["is_read"] = state, True
        named.update({notice["recipient_id"], notice["actor_id"]})


def add_notice(S, kind, recipient, actor, group, entry, named):
    nid = alloc(S, "notifications")
    S["notifications"][str(nid)] = {
        "id": nid, "recipient_id": recipient, "actor_id": actor, "type": kind, "post_id": None,
        "comment_id": None, "group_id": group, "entry_id": entry, "state": "pending", "is_read": False,
        "created_at": PACK["clock"],
    }
    named.update({recipient, actor})


def invalidate(S, group, named, membership_changed):
    if membership_changed:
        named |= active_members(S, group)
    return {"type": "social.invalidate", "recipients": sorted(named)}


def admit(S, group, user, named):
    mid = alloc(S, "group_memberships")
    S["group_memberships"][str(mid)] = {"id": mid, "group_id": group, "user_id": user, "role": "member",
                                        "joined_at": PACK["clock"]}
    named.add(user)
    return S["group_memberships"][str(mid)]


def drop_pending_for(S, group, user, winner_invitation, winner_request, named):
    for inv in [i for i in rows(S, "group_invitations") if i["group_id"] == group and i["invitee_id"] == user]:
        del S["group_invitations"][str(inv["id"])]
        named.update({inv["inviter_id"], inv["invitee_id"]})
        resolve_notice(S, "group_invitation", inv["id"],
                       "accepted" if inv["id"] == winner_invitation else "superseded", named)
    for r in [r for r in rows(S, "group_join_requests") if r["group_id"] == group and r["requester_id"] == user]:
        del S["group_join_requests"][str(r["id"])]
        named.update({r["requester_id"], S["groups"][str(group)]["creator_id"]})
        resolve_notice(S, "group_join_request", r["id"],
                       "accepted" if r["id"] == winner_request else "superseded", named)


def apply(state, viewer, method, path, body=None):
    S = copy.deepcopy(state)
    path = path.split("?")[0]
    assert path.startswith("/api/v1")
    path = path[len("/api/v1"):]
    parts = [p for p in path.split("/") if p]
    body = body or {}
    if not is_active(S, viewer):
        return Result(state, 401, "UNAUTHORIZED")

    def fail(status, code=None):
        return Result(state, status, code)

    if (method, parts) == ("POST", ["groups"]):
        gid = alloc(S, "groups")
        S["groups"][str(gid)] = {"id": gid, "creator_id": viewer, "title": body["title"].strip(),
                                 "description": body["description"].replace("\r\n", "\n").strip(),
                                 "created_at": PACK["clock"]}
        mid = alloc(S, "group_memberships")
        S["group_memberships"][str(mid)] = {"id": mid, "group_id": gid, "user_id": viewer, "role": "creator",
                                            "joined_at": PACK["clock"]}
        return Result(S, 201, None, [{"type": "social.invalidate", "recipients": ALL}])

    if method == "POST" and len(parts) == 3 and parts[0] == "groups" and parts[2] == "invitations":
        gid, target = int(parts[1]), body["user_id"]
        if str(gid) not in S["groups"] or membership(S, gid, viewer) is None:
            return fail(404)
        if not is_active(S, target):
            return fail(404)
        if membership(S, gid, target):
            return fail(409, "ALREADY_MEMBER")
        if any(i["group_id"] == gid and i["inviter_id"] == viewer and i["invitee_id"] == target
               for i in rows(S, "group_invitations")):
            return Result(S, 200)
        iid = alloc(S, "group_invitations")
        S["group_invitations"][str(iid)] = {"id": iid, "group_id": gid, "inviter_id": viewer,
                                            "invitee_id": target, "created_at": PACK["clock"]}
        named = set()
        add_notice(S, "group_invitation", target, viewer, gid, iid, named)
        return Result(S, 201, None, [{"type": "notification.new", "recipients": [target]},
                                     invalidate(S, gid, named, False)])

    if method == "PATCH" and len(parts) == 2 and parts[0] == "group-invitations":
        inv = S["group_invitations"].get(parts[1])
        if inv is None:
            return fail(409, "STALE_INVITATION")
        if inv["invitee_id"] != viewer:
            return fail(404)
        if membership(S, inv["group_id"], inv["inviter_id"]) is None:
            return fail(409, "STALE_INVITATION")  # invariant: departure deletes these
        gid, named = inv["group_id"], set()
        if body["decision"] == "accept":
            if membership(S, gid, viewer):
                return fail(409, "ALREADY_MEMBER")
            admit(S, gid, viewer, named)
            drop_pending_for(S, gid, viewer, inv["id"], None, named)
            return Result(S, 200, None, [invalidate(S, gid, named, True)])
        del S["group_invitations"][str(inv["id"])]
        named.update({inv["inviter_id"], viewer})
        resolve_notice(S, "group_invitation", inv["id"], "refused", named)
        return Result(S, 204, None, [invalidate(S, gid, named, False)])

    if method == "POST" and len(parts) == 3 and parts[0] == "groups" and parts[2] == "join-requests":
        gid = int(parts[1])
        if str(gid) not in S["groups"]:
            return fail(404)
        if membership(S, gid, viewer):
            return fail(409, "ALREADY_MEMBER")
        if any(r["group_id"] == gid and r["requester_id"] == viewer for r in rows(S, "group_join_requests")):
            return Result(S, 200)
        rid = alloc(S, "group_join_requests")
        S["group_join_requests"][str(rid)] = {"id": rid, "group_id": gid, "requester_id": viewer,
                                              "created_at": PACK["clock"]}
        creator, named = S["groups"][str(gid)]["creator_id"], set()
        add_notice(S, "group_join_request", creator, viewer, gid, rid, named)
        return Result(S, 201, None, [{"type": "notification.new", "recipients": [creator]},
                                     invalidate(S, gid, named, False)])

    if method == "PATCH" and len(parts) == 2 and parts[0] == "group-join-requests":
        r = S["group_join_requests"].get(parts[1])
        if r is None:
            return fail(409, "STALE_JOIN_REQUEST")
        gid = r["group_id"]
        if S["groups"][str(gid)]["creator_id"] != viewer:
            return fail(404)
        named = {viewer}
        if body["decision"] == "accept":
            if membership(S, gid, r["requester_id"]):
                return fail(409, "ALREADY_MEMBER")
            admit(S, gid, r["requester_id"], named)
            drop_pending_for(S, gid, r["requester_id"], None, r["id"], named)
            return Result(S, 200, None, [invalidate(S, gid, named, True)])
        del S["group_join_requests"][str(r["id"])]
        named.add(r["requester_id"])
        resolve_notice(S, "group_join_request", r["id"], "refused", named)
        return Result(S, 204, None, [invalidate(S, gid, named, False)])

    if method == "DELETE" and len(parts) == 2 and parts[0] == "group-memberships":
        m = S["group_memberships"].get(parts[1])
        if m is None:
            return fail(409, "STALE_MEMBERSHIP")
        gid = m["group_id"]
        if m["user_id"] == viewer:
            if m["role"] == "creator":
                return fail(409, "CREATOR_CANNOT_LEAVE")
        else:
            actor = membership(S, gid, viewer)
            if actor is None or actor["role"] != "creator":
                return fail(404)
        named = {m["user_id"]}
        del S["group_memberships"][str(m["id"])]
        for inv in [i for i in rows(S, "group_invitations") if i["group_id"] == gid and i["inviter_id"] == m["user_id"]]:
            del S["group_invitations"][str(inv["id"])]
            named.update({inv["inviter_id"], inv["invitee_id"]})
            resolve_notice(S, "group_invitation", inv["id"], "cancelled", named)
        return Result(S, 204, None, [invalidate(S, gid, named, True)])

    if method == "PATCH" and parts[:1] == ["notifications"]:
        def visible(n):
            if n["type"] in NOTICE_STATES:
                return True
            pid = n["post_id"] if n["post_id"] is not None else S["comments"][str(n["comment_id"])]["post_id"]
            return can_read_post(S, n["recipient_id"], pid)

        if parts[1:] == ["read-all"]:
            changed = [n for n in rows(S, "notifications")
                       if n["recipient_id"] == viewer and not n["is_read"] and visible(n)]
            for n in changed:
                n["is_read"] = True
            return Result(S if changed else state, 204, None,
                          [{"type": "social.invalidate", "recipients": [viewer]}] if changed else [])
        note = S["notifications"].get(parts[1])
        if note is None or note["recipient_id"] != viewer or not visible(note):
            return fail(404)
        changed = not note["is_read"]
        note["is_read"] = True
        return Result(S if changed else state, 204, None,
                      [{"type": "social.invalidate", "recipients": [viewer]}] if changed else [])

    # Coarse content writes: only the membership/readability decision matters here.
    if method == "POST" and parts == ["posts"]:
        gid = body.get("group_id")
        if gid is not None and membership(S, gid, viewer) is None:
            return fail(404)
        pid = alloc(S, "posts")
        S["posts"][str(pid)] = {"id": pid, "author_id": viewer, "group_id": gid, "status": "published",
                                "audience": "group" if gid else "public", "created_at": PACK["clock"]}
        return Result(S, 201)
    if method == "POST" and len(parts) == 3 and parts[0] == "posts" and parts[2] in ("comments", "like", "dislike"):
        if not can_read_post(S, viewer, int(parts[1])):
            return fail(404)
        if parts[2] == "comments":
            cid = alloc(S, "comments")
            S["comments"][str(cid)] = {"id": cid, "post_id": int(parts[1]), "user_id": viewer}
            return Result(S, 201)
        rid = alloc(S, "reactions")
        S["reactions"][str(rid)] = {"id": rid, "user_id": viewer, "post_id": int(parts[1]),
                                    "value": 1 if parts[2] == "like" else -1}
        return Result(S, 200)
    if method in ("PATCH", "DELETE") and len(parts) == 2 and parts[0] == "posts":
        post = S["posts"].get(parts[1])
        if post is None or post["author_id"] != viewer or not can_read_post(S, viewer, post["id"]):
            return fail(404)
        return Result(S, 200)
    raise ValueError(f"model has no route for {method} {path}")


def check_expect(state, expect, name):
    for table, records in expect.items():
        if table == "next_ids":
            for key, value in records.items():
                require(state[table][key] == value, f"{name}: next_ids.{key}")
            continue
        for rid, wanted in records.items():
            if wanted is None:
                require(rid not in state[table], f"{name}: {table}.{rid} should be absent")
                continue
            require(rid in state[table], f"{name}: {table}.{rid} missing")
            for key, value in wanted.items():
                require(state[table][rid].get(key) == value,
                        f"{name}: {table}.{rid}.{key} = {state[table][rid].get(key)!r}, wanted {value!r}")


def signal_set(signals):
    out = set()
    for s in signals:
        rec = s["recipients"]
        out.add((s["type"], rec if rec == ALL else tuple(rec)))
    return out


def run_model(S, viewer, request, response, expect, signals, name, unchanged=False):
    result = apply(S, viewer, request["method"], request["path"], request.get("body"))
    require(result.status == response["status"], f"{name}: model status {result.status} != {response['status']}")
    if response["status"] >= 400:
        require(result.code == response["body"]["error"]["code"] or result.code is None and
                response["body"]["error"]["code"] in {"NOT_FOUND", "UNAUTHORIZED"},
                f"{name}: model code {result.code}")
        require(result.state == S, f"{name}: failed request changed model state")
    if unchanged:
        require(result.state == S, f"{name}: unchanged request changed model state")
    if expect:
        check_expect(result.state, expect, name)
    if signals is not None and response["status"] < 400:
        require(signal_set(signals) == signal_set(result.signals),
                f"{name}: signals {signal_set(signals)} != model {signal_set(result.signals)}")
    return result


# ----------------------------------------------------------------------------
# Wire/schema checks
# ----------------------------------------------------------------------------
def check_people(obj, name):
    base = {"id", "display_name", "access", "relationship"}
    expected = base | ({"avatar_url"} if obj["access"] == "full" else set())
    require(obj["access"] in {"full", "teaser"} and set(obj) - {"membership"} == expected,
            f"{name}: People entry shape/redaction")
    require(set(obj["relationship"]) == {"state", "follow_id"}
            and obj["relationship"]["state"] in {"self", "none", "pending", "accepted"}, f"{name}: relationship")
    if obj["relationship"]["state"] in {"self", "none"}:
        require(obj["relationship"]["follow_id"] is None, f"{name}: relationship id")


def check_group(obj, name):
    viewer = obj["viewer"]
    require(set(viewer) == {"role", "membership_id", "invitations", "join_request"}, f"{name}: viewer shape")
    role = viewer["role"]
    require(role in {"creator", "member", "none"}, f"{name}: role")
    expected = GROUP_FIELDS | ({"member_count"} if role != "none" else set())
    require(set(obj) == expected, f"{name}: Group fields {set(obj) ^ expected} (member_count only for members)")
    require(set(obj["creator"]) == {"id", "display_name"}, f"{name}: creator exposes only id/display name")
    if role == "none":
        require(viewer["membership_id"] is None, f"{name}: none has no membership")
    else:
        require(isinstance(viewer["membership_id"], int) and viewer["invitations"] == []
                and viewer["join_request"] is None and obj["member_count"] >= 1,
                f"{name}: member view must not carry resolved entries")
    for inv in viewer["invitations"]:
        require(set(inv) == {"id", "created_at", "inviter"} and set(inv["inviter"]) == {"id", "display_name"}, name)
    if viewer["join_request"] is not None:
        require(set(viewer["join_request"]) == {"id", "created_at"}, name)


def check_post(obj, viewer, name):
    group = obj["group"]
    extra = {"selected_follower_ids"} if group is None and obj["author_id"] == viewer else set()
    require(set(obj) == POST_FIELDS | extra, f"{name}: Post schema/redaction mismatch")
    if group is None:
        require(obj["audience"] in {"public", "followers", "selected"}, f"{name}: personal audience")
    else:
        require(set(group) == {"id", "title"} and obj["audience"] == "group", f"{name}: group post scope")
    require(obj["status"] in {"published", "draft", "archived"} and 0 < obj["version"] <= MAX_ID, name)


def check_notice(obj, name):
    require(set(obj) == {"id", "type", "created_at", "is_read", "actor", "target", "actions"}, f"{name}: Notice")
    check_people(obj["actor"], name)
    target, kind = obj["target"], obj["type"]
    if kind in NOTICE_STATES:
        key = "invitation_id" if kind == "group_invitation" else "request_id"
        require(set(target) == {"kind", key, "group", "state"} and target["kind"] == kind
                and set(target["group"]) == {"id", "title"} and target["state"] in NOTICE_STATES[kind], name)
        require(obj["actions"] == (["accept", "refuse"] if target["state"] == "pending" else []),
                f"{name}: actions must follow current pending state")
        if target["state"] != "pending":
            require(obj["is_read"] is True, f"{name}: resolved notices are read")
    else:
        require(target["kind"] in {"post", "comment"} and obj["actions"] == [], name)


def check_exchange(exchange, viewer, name):
    request, response = exchange["request"], exchange["response"]
    require(request["method"] in {"GET", "POST", "PATCH", "PUT", "DELETE"}, name)
    require(request["path"].startswith(("/api/v1/", "/static/")), name)
    status = response["status"]
    require(status in {200, 201, 204, 400, 401, 403, 404, 405, 409, 413, 415, 422, 500, 503}, name)
    require(response["headers"].get("Cache-Control") == "no-store", name)
    require(sum(k in response for k in ("body", "bytes_fixture", "empty_body")) == 1, f"{name}: body representation")
    if status == 204:
        require(response.get("empty_body") is True, name)
    if "bytes_fixture" in response:
        require(status == 200 and (ROOT / response["bytes_fixture"]).is_file(), name)
        require(response["headers"].get("X-Content-Type-Options") == "nosniff", name)
    body = response.get("body", {})
    if status >= 400:
        require(set(body) == {"error"}, f"{name}: error body")
        error = body["error"]
        require(error["code"] in ERROR_CODES and error["message"], f"{name}: error code")
        if error["code"] in PINNED:
            require((status, error["message"]) == PINNED[error["code"]], f"{name}: pinned error text/status")
        if error["code"] == "VALIDATION_ERROR":
            require(error["message"] == "Check the highlighted fields" and error["fields"], name)
            require(set(error["fields"].values()) <= FIELD_CODES, f"{name}: field code")
        if error["code"] == "SELF_INVITE":
            require(error["fields"] == {"user_id": "SELF_INVITE"}, name)
    elif "body" in response:
        require("data" in body and "error" not in body, name)
    forbidden = {"password_hash", "session_token", "email", "selected_follow_ids", "date_of_birth", "about_me"}
    for obj in walk(body):
        require(not (forbidden & obj.keys()), f"{name}: secret/internal field in response")
        if {"creator", "viewer", "title"} <= obj.keys():
            check_group(obj, name)
        elif "author_id" in obj and "status" in obj:
            check_post(obj, viewer, name)
        elif "parent_comment_id" in obj and "username" in obj:
            require(set(obj) in (COMMENT_FIELDS, COMMENT_FIELDS | {"post"}), f"{name}: Comment schema")
            if "post" in obj:
                require(set(obj["post"]) == {"id", "author_id", "author", "title", "image_url", "categories",
                                             "likes", "dislikes", "my_reaction", "group"}, name)
        elif "access" in obj and "relationship" in obj:
            check_people(obj, name)
        elif "actions" in obj and "target" in obj:
            check_notice(obj, name)
        elif obj.keys() >= MEMBERSHIP_FIELDS and "inviter" not in obj:
            require(set(obj) == MEMBERSHIP_FIELDS and obj["role"] in {"creator", "member"}, f"{name}: Membership")
        elif {"inviter", "invitee"} <= obj.keys():
            require(set(obj) == {"id", "created_at", "group", "inviter", "invitee"}
                    and set(obj["group"]) == SUMMARY_FIELDS and set(obj["group"]["creator"]) == {"id", "display_name"}, name)
        elif "requester" in obj:
            require(set(obj) == {"id", "created_at", "group", "requester"}
                    and set(obj["group"]) == SUMMARY_FIELDS, name)
        if "total_pages" in obj:
            require(set(obj) == {"page", "per_page", "total", "total_pages"}, name)
            require(1 <= obj["page"] <= 1000000 and 1 <= obj["per_page"] <= 50, name)
            require(obj["total_pages"] == (obj["total"] + obj["per_page"] - 1) // obj["per_page"], name)
    if status == 405:
        require(response["headers"].get("Allow"), name)
    for fixture in request.get("files", {}).values():
        if isinstance(fixture, str):
            require((ROOT / fixture).is_file(), f"{name}: missing upload fixture")


def check_signals(case):
    name = case["name"]
    if case["response"]["status"] >= 400:
        require(case.get("unchanged") is True and case.get("signals") == [], f"{name}: failure must be silent")
    for signal in case.get("signals", []):
        require(set(signal) == {"type", "recipients"}, f"{name}: signal payload leak")
        require(signal["type"] in {"social.invalidate", "notification.new"}, name)
        rec = signal["recipients"]
        require(rec == ALL or (isinstance(rec, list) and rec == sorted(set(rec)) and rec), name)
        if signal["type"] == "notification.new":
            require(rec != ALL, f"{name}: notification.new is recipient-only")


def check_state(S, name):
    for table in TABLES:
        top = max((int(k) for k in S[table]), default=0)
        require(S["next_ids"][table] > top, f"{name}: next_ids.{table} reuses or precedes an existing ID")
    for g in rows(S, "groups"):
        creators = [m for m in rows(S, "group_memberships") if m["group_id"] == g["id"] and m["role"] == "creator"]
        require(len(creators) == 1 and creators[0]["user_id"] == g["creator_id"], f"{name}: creator invariant")
    seen = set()
    for m in rows(S, "group_memberships"):
        require((m["group_id"], m["user_id"]) not in seen, f"{name}: duplicate membership")
        seen.add((m["group_id"], m["user_id"]))
    for inv in rows(S, "group_invitations"):
        require(raw_member(S, inv["group_id"], inv["inviter_id"]), f"{name}: pending invitation from non-member")
        require(not raw_member(S, inv["group_id"], inv["invitee_id"]), f"{name}: pending invitation to member")
    for r in rows(S, "group_join_requests"):
        require(not raw_member(S, r["group_id"], r["requester_id"]), f"{name}: pending request from member")
    for p in rows(S, "posts"):
        if p["group_id"] is not None:
            require(p["audience"] == "group" and not p.get("selected_follow_ids"), f"{name}: group post audience")
    for n in rows(S, "notifications"):
        if n["type"] in NOTICE_STATES:
            require(n["state"] in NOTICE_STATES[n["type"]], f"{name}: notice state")
            live = S["group_invitations" if n["type"] == "group_invitation" else "group_join_requests"]
            require((n["state"] == "pending") == (str(n["entry_id"]) in live) or n["state"] != "pending",
                    f"{name}: pending notice without an entry")
            if n["state"] == "pending":
                require(str(n["entry_id"]) in live, f"{name}: pending notice needs a live entry")


# ----------------------------------------------------------------------------
# Fixture pack
# ----------------------------------------------------------------------------
def check_fixtures():
    require(PACK["schema_version"] == 1, "Unknown fixture schema")
    require(PACK["review_status"] == "draft; owner approval pending" or
            re.fullmatch(r"owner-approved \d{4}-\d{2}-\d{2}; fixture completeness/consistency checked",
                         PACK["review_status"]), "Approval metadata mismatch")
    base = PACK["state"]
    check_state(base, "base")
    cases = PACK["cases"]
    require(len(cases) == len({c["name"] for c in cases}), "Duplicate case name")
    tags, matrix, modeled = set(), {}, 0
    for case in cases:
        name = case["name"]
        S = merge(base, case["given"])
        check_state(S, name + " (given)")
        viewer = case["viewer_id"]
        check_exchange(case, viewer, name)
        check_signals(case)
        tags.update(case["tags"])
        response = case["response"]
        if "model" in case["tags"]:
            run_model(S, viewer, case["request"], response, case.get("expect_state"), case.get("signals"),
                      name, case.get("unchanged", False))
            modeled += 1
        if "matrix" in case:
            m = case["matrix"]
            allowed = can_read_post(S, ROLE_USER_BY_NAME(m["role"]), m["post"]) if m["post"] else None
            surface = m["surface"]
            key = (m["role"], m["post"], surface)
            require(key not in matrix, f"{name}: duplicate matrix cell")
            matrix[key] = m
            require(viewer == ROLE_USER[m["role"]], f"{name}: matrix viewer")
            if surface in {"detail", "thread", "media"}:
                require(m["allowed"] == allowed, f"{name}: matrix contradicts policy oracle")
                require(response["status"] == (200 if allowed else 404), name)
            elif surface == "group-feed":
                gid = 301
                is_member = membership(S, gid, viewer) is not None
                require(m["allowed"] == is_member and response["status"] == (200 if is_member else 404), name)
                if is_member:
                    wanted = [p["id"] for p in visible_published(S, viewer) if p["group_id"] == gid]
                    require([p["id"] for p in response["body"]["data"]] == wanted, f"{name}: group feed set")
                    require(response["body"]["meta"]["pagination"]["total"] == len(wanted), name)
            else:
                wanted = [p["id"] for p in visible_published(S, viewer)]
                require([p["id"] for p in response["body"]["data"]] == wanted, f"{name}: home feed set")
                require(response["body"]["meta"]["pagination"]["total"] == len(wanted), f"{name}: leaked total")
    expected = set()
    for role in ROLES:
        for pid, surfaces in {111: ["detail", "thread", "media"], 112: ["detail", "thread", "media"],
                              113: ["detail", "media"], 114: ["detail", "media"]}.items():
            expected |= {(role, pid, s) for s in surfaces}
        expected |= {(role, None, "group-feed"), (role, None, "home-feed")}
    require(set(matrix) == expected, f"Missing/extra matrix cells: {set(matrix) ^ expected}")
    # Hand-checked policy anchors guard the oracle itself.
    anchors = {("creator", 111, "detail"): True, ("member", 113, "detail"): True, ("creator", 113, "detail"): False,
               ("departed-author", 112, "detail"): False, ("departed-author", 114, "detail"): False,
               ("follower", 111, "detail"): False, ("invitee", 111, "media"): False,
               ("requester", 111, "thread"): False, ("departed-member", 112, "media"): False,
               ("outsider", 112, "detail"): False, ("creator", 112, "detail"): True}
    for key, value in anchors.items():
        require(matrix[key]["allowed"] is value, f"Policy anchor {key}")
    required_tags = {
        "groups", "list", "detail", "role", "create", "invalid", "structure", "transport", "auth", "inactive",
        "members", "redaction", "paging", "filter", "invitations", "requests", "decision", "admission",
        "refusal", "duplicate", "stale", "denied", "departed-inviter", "return", "memberships", "leave",
        "remove", "departure", "creator", "notice", "history", "read", "content", "group", "matrix",
        "broaden", "profile", "activity", "aggregate", "navigation", "draft", "comments", "reaction",
        "media-alias", "pending-invitation", "pending-request",
    }
    require(required_tags <= tags, f"Missing coverage: {required_tags - tags}")
    decisions = {c["name"] for c in cases}
    for must in ["invitation-stale-after-inviter-rejoined", "request-stale-after-invitation-admission",
                 "remove-old-membership-after-return", "leave-creator-denied", "invite-already-member",
                 "notice-creator-cannot-act-on-invitee-notice", "post-create-group-with-audience",
                 "post-edit-foreign-by-creator", "post-edit-after-departure",
                 "personal-post-not-broadened-by-shared-group", "group-post-not-broadened-by-follow",
                 "profile-posts-teaser-despite-membership", "invitation-stale-after-accept-no-replay"]:
        require(must in decisions, f"Missing required case {must}")
    return modeled


def ROLE_USER_BY_NAME(role):
    return ROLE_USER[role]


def check_sequences_and_races():
    base = PACK["state"]
    sequences = {s["name"]: s for s in PACK["sequences"]}
    require(set(sequences) == {"obsolete-invitation-after-inviter-rejoin", "removal-is-not-a-ban-return-by-request",
                               "removal-return-by-member-invitation", "refusal-is-not-a-ban",
                               "creator-retention"}, "Sequence set changed")
    steps_total = 0
    for seq in sequences.values():
        S = merge(base, seq["given"])
        for index, step in enumerate(seq["steps"], 1):
            name = f"{seq['name']}#{index}"
            check_exchange(step, step["viewer_id"], name)
            request, response = step["request"], step["response"]
            if request["method"] == "GET":
                path = request["path"].split("?")[0].split("/")
                if len(path) == 5 and path[3] == "posts":
                    allowed = can_read_post(S, step["viewer_id"], int(path[4]))
                    require(response["status"] == (200 if allowed else 404), f"{name}: read contradicts oracle")
                if request["path"].endswith("/members"):
                    require(response["status"] == (200 if membership(S, int(path[4]), step["viewer_id"]) else 404), name)
                require("expect_state" not in step, name)
                continue
            result = run_model(S, step["viewer_id"], request, response, step.get("expect_state"),
                               step.get("signals"), name)
            S = result.state
            check_state(S, name)
            steps_total += 1
    # Sequence-specific postconditions.
    s1 = sequences["obsolete-invitation-after-inviter-rejoin"]["steps"]
    require(s1[4]["response"]["status"] == 409 and s1[5]["response"]["body"]["data"]["id"] == 603, "Obsolete invitation")
    s2 = sequences["removal-is-not-a-ban-return-by-request"]["steps"]
    require(s2[-1]["response"]["body"]["error"]["code"] == "STALE_MEMBERSHIP", "Stale removal after return")
    final_members = None
    for race in PACK["races"]:
        name = race["name"]
        start = merge(base, race["given"])
        check_state(start, name)
        require(set(race["outcomes"]) == {"A,B", "B,A"}, f"{name}: both orders")
        for order, outcome in race["outcomes"].items():
            S = start
            for label in order.split(","):
                op = race["ops"][label]
                result = apply(S, op["viewer"], op["request"]["method"], op["request"]["path"], op["request"].get("body"))
                want_status, want_code = outcome[label]
                require(result.status == want_status, f"{name} {order}/{label}: status {result.status}")
                require(want_code is None or result.code == want_code, f"{name} {order}/{label}: code {result.code}")
                S = result.state
                check_state(S, f"{name} {order}")
            check_expect(S, outcome["final"], f"{name} {order}")
            # Never two memberships for one person and group, whatever the order.
            pairs = [(m["group_id"], m["user_id"]) for m in rows(S, "group_memberships")]
            require(len(pairs) == len(set(pairs)), f"{name} {order}: duplicate membership")
    required_races = {
        "accept-versus-refuse-invitation", "accept-invitation-versus-inviter-leaves", "accept-two-invitations",
        "invitation-accept-versus-request-accept", "leave-versus-remove", "duplicate-invitation-create",
        "duplicate-request-create", "removal-versus-member-comment", "removal-versus-member-reaction",
        "removal-versus-member-post", "removal-versus-member-invite",
        "creator-accepts-request-versus-requester-accepts-invitation",
    }
    require(required_races <= {r["name"] for r in PACK["races"]}, "Missing race")
    require({r["name"] for r in PACK["recovery_examples"]} >= {
        "missed-signal-reconnect-refetch", "committed-write-failed-signal",
        "restart-preserves-membership-and-stale-identities", "pre-phase-4-upgrade"}, "Missing recovery example")
    return steps_total


# ----------------------------------------------------------------------------
# Documents, tracker and ticket graph
# ----------------------------------------------------------------------------
def anchor(text):
    return re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")


def check_docs_and_tracker():
    files = [DOCS / name for name in ["groups-contract.md", "phase-4-data-plan.md", "CONTEXT.md",
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
    rows_ = re.findall(r"^\| \[(x| |-|!)\] \| \[(SN-[AB]\d+)\].*$", tracker, re.M)
    require(len(rows_) == len({t for _, t in rows_}) == 36, "Tracker duplicate/missing row")
    statuses = {ticket: status for status, ticket in rows_}
    require(statuses["SN-A14"] == "x", "Prerequisite incomplete")
    approved = PACK["review_status"].startswith("owner-approved ")
    require(statuses["SN-B17"] == ("x" if approved else "-"), "B17 status/approval mismatch")
    if not approved:
        require(statuses["SN-B18"] == statuses["SN-A15"] == " ", "Consumers must wait for approval")
    for line in tracker.splitlines():
        match = re.match(r"\| \[[x !-]\] \| \[(SN-[AB]\d+)\]", line)
        if match:
            cells = line.split("|")
            ticket = match.group(1)
            require(set(re.findall(r"SN-[AB]\d+", cells[4])) == tickets[ticket][0], f"Tracker deps {ticket}")
            require(set(re.findall(r"SN-[AB]\d+", cells[5])) == tickets[ticket][1], f"Tracker blocks {ticket}")
    counts = {s: sum(v == s for v in statuses.values()) for s in ["x", "-", "!", " "]}
    summary = (f"Done: {counts['x']}. In progress: {counts['-']}. "
               f"Blocked: {counts['!']}. Not started: {counts[' ']}.")
    require(summary in tracker, "Summary mismatch")
    phase4 = re.search(r"^\| 4 \| 3 \| 3 \| 6 \| (\d+) \| (\d+) \| (\d+) \|", tracker, re.M)
    require(phase4 and tuple(map(int, phase4.groups())) == (
        sum(statuses[t] == "x" for t in statuses if t in {"SN-A15", "SN-A16", "SN-A17", "SN-B17", "SN-B18", "SN-B19"}),
        sum(statuses[t] == "-" for t in statuses if t in {"SN-A15", "SN-A16", "SN-A17", "SN-B17", "SN-B18", "SN-B19"}),
        sum(statuses[t] == " " for t in statuses if t in {"SN-A15", "SN-A16", "SN-A17", "SN-B17", "SN-B18", "SN-B19"}),
    ), "Phase 4 summary row mismatch")
    contract = (DOCS / "groups-contract.md").read_text()
    for raw in re.findall(r"```json\n(.*?)\n```", contract, re.S):
        json.loads(raw)
    require(("owner-approved contract and fixture handoff" if approved else "owner approval pending")
            in contract.lower(), "Contract approval not explicit")
    plan = (DOCS / "phase-4-data-plan.md").read_text()
    for invariant in ["000006", "000007", "sqlite_sequence", "AUTOINCREMENT", "group_id", "MEDIA_ROOT",
                      "foreign_key_check", "pending DMs"]:
        require(invariant in plan, f"Data plan omits {invariant}")
    for code in PINNED:
        if code not in {"STALE_CONTENT"}:
            require(code in contract, f"Contract omits {code}")
    for route in ["POST /groups", "GET /groups", "/groups/{id}/members", "/groups/{id}/invitations",
                  "/group-invitations/{id}", "/groups/{id}/join-requests", "/group-join-requests/{id}",
                  "/group-memberships/{id}", "/users/me/group-invitations"]:
        require(route in contract, f"Contract omits route {route}")
    print(f"{links} local links/anchors; 36-ticket graph/reverse edges/status counts; JSON examples valid")


if __name__ == "__main__":
    modeled = check_fixtures()
    steps = check_sequences_and_races()
    cases = PACK["cases"]
    print(f"{len(cases)} HTTP fixtures ({modeled} replayed through the independent state machine); "
          f"{len(PACK['sequences'])} sequences/{steps} mutating steps; {len(PACK['races'])} two-order races; "
          "8 roles x 4 posts access matrix with feeds")
    check_docs_and_tracker()
