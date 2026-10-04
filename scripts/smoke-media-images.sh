#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backend_image="${1:-social-network-backend}"
frontend_image="${2:-social-network-frontend}"
label="sn-b13-media-$$"
backend="$label-backend"
frontend="$label-frontend"
volume="$label-data"
network="$label-network"
work="$(mktemp -d)"
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    docker logs "$backend" 2>/dev/null || true
    docker logs "$frontend" 2>/dev/null || true
  fi
  docker rm -f "$backend" "$frontend" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$work/legacy/dm" "$work/data"
cp SPA/tests/fixtures/a07/avatar.png "$work/legacy/kept.png"
cp "$work/legacy/kept.png" "$work/legacy/dm/kept.png"
chmod 755 "$work" "$work/legacy" "$work/legacy/dm"
chmod 644 "$work/legacy/kept.png" "$work/legacy/dm/kept.png"
docker network create "$network" >/dev/null
docker run -d --name "$backend" --network "$network" --network-alias backend \
  -p 127.0.0.1::8080 -v "$volume:/data" -v "$work/legacy:/legacy:ro" \
  -e LEGACY_UPLOAD_ROOTS=/legacy -e FRONTEND_URL=http://localhost:3000 "$backend_image" >/dev/null
docker run -d --name "$frontend" --network "$network" -p 127.0.0.1::3000 \
  -v "$work/legacy:/app/web/static/uploads:ro" -e BACKEND_URL=http://backend:8080 "$frontend_image" >/dev/null
backend_base="http://127.0.0.1:$(docker port "$backend" 8080/tcp | sed 's/.*://')"
frontend_base="http://127.0.0.1:$(docker port "$frontend" 3000/tcp | sed 's/.*://')"
wait_ready() {
  # Docker may allocate a new ephemeral host port after stop/start or restart.
  backend_base="http://127.0.0.1:$(docker port "$backend" 8080/tcp | sed 's/.*://')"
  frontend_base="http://127.0.0.1:$(docker port "$frontend" 3000/tcp | sed 's/.*://')"
  for _ in {1..60}; do
    if curl -fsS "$backend_base/api/v1/health" >/dev/null 2>&1 && curl -fsS "$frontend_base/healthz" >/dev/null 2>&1; then return; fi
    sleep 0.25
  done
  echo 'media images did not become ready' >&2
  return 1
}
write_headers=(-H 'Origin: http://localhost:3000' -H 'X-Requested-With: XMLHttpRequest')
wait_ready
for actor in owner viewer outsider; do
  curl -fsS -c "$work/$actor.cookies" "${write_headers[@]}" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$actor@b13.test\",\"password\":\"correct horse battery\",\"first_name\":\"$actor\",\"last_name\":\"Media\",\"date_of_birth\":\"2000-01-01\"}" \
    "$frontend_base/api/v1/users/register" > "$work/$actor.json"
done
curl -fsS -b "$work/owner.cookies" "${write_headers[@]}" -H 'Content-Type: application/json' \
  -d '{"title":"legacy fixture","body":"retained body","category_ids":[1]}' \
  "$frontend_base/api/v1/posts" > "$work/post.json"
# Seed committed historical references while writers are stopped. Copy SQLite
# plus sidecars, checkpoint the disposable copy, then replace the isolated DB.
docker stop "$backend" >/dev/null
docker cp "$backend:/data/." "$work/data"
python3 - "$work" <<'PY'
import json, pathlib, sqlite3, sys
work = pathlib.Path(sys.argv[1])
post = json.load(open(work / 'post.json'))['data']['id']
owner = json.load(open(work / 'owner.json'))['data']['id']
viewer = json.load(open(work / 'viewer.json'))['data']['id']
with sqlite3.connect(work / 'data/social.db') as conn:
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    conn.execute('UPDATE posts SET image_url=? WHERE id=?', ('/static/uploads/kept.png', post))
    conn.execute('INSERT INTO comments(post_id,user_id,body,image_url) VALUES(?,?,?,?)', (post, viewer, 'legacy comment', 'web/static/uploads/kept.png'))
    conn.execute('INSERT INTO private_messages(sender_id,recipient_id,body,image_path) VALUES(?,?,?,?)', (owner, viewer, 'legacy DM', '/static/uploads/dm/kept.png'))
    conn.commit()
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
PY
docker cp "$work/data/social.db" "$backend:/data/social.db"
docker run --rm --user 0 --entrypoint sh -v "$volume:/data" "$backend_image" \
  -c 'rm -f /data/social.db-wal /data/social.db-shm; chown 10001:10001 /data/social.db'
docker start "$backend" >/dev/null
wait_ready
assert_read() {
  local base="$1" actor="$2" path="$3" expected="$4" status
  status="$(curl --path-as-is -sS -o "$work/read" -w '%{http_code}' -b "$work/$actor.cookies" "$base$path")"
  if [ "$status" != "$expected" ]; then
    echo "media status $status expected $expected: $actor $base$path" >&2
    cat "$work/read" >&2
    return 1
  fi
  if [ "$expected" = 200 ]; then cmp "$work/legacy/kept.png" "$work/read"; fi
}
for base in "$backend_base" "$frontend_base"; do
  assert_read "$base" viewer /static/uploads/kept.png 200
  assert_read "$base" viewer /static/uploads/dm/kept.png 200
  assert_read "$base" outsider /static/uploads/dm/kept.png 404
done
curl -fsS -b "$work/owner.cookies" "${write_headers[@]}" -H 'Content-Type: application/json' \
  -X PATCH -d '{"visibility":"private","expected_version":1}' "$frontend_base/api/v1/users/me/privacy" >/dev/null
for base in "$backend_base" "$frontend_base"; do
  assert_read "$base" owner /static/uploads/kept.png 200
  assert_read "$base" viewer /static/uploads/kept.png 404
  assert_read "$base" viewer /static/uploads/dm/kept.png 200
  for path in '/static/%75ploads/kept.png' '//static/uploads/kept.png' '/static/x/../uploads/kept.png'; do
    assert_read "$base" viewer "$path" 404
  done
  status="$(curl --path-as-is -sS -o "$work/read" -w '%{http_code}' "$base/static/uploads/kept.png")"
  [ "$status" = 401 ]
done
# A further restart preserves copied bytes, historical references and sessions.
docker restart "$backend" >/dev/null
wait_ready
for base in "$backend_base" "$frontend_base"; do
  assert_read "$base" owner /static/uploads/kept.png 200
  assert_read "$base" viewer /static/uploads/dm/kept.png 200
  assert_read "$base" viewer /static/uploads/kept.png 404
done
cmp "$work/legacy/kept.png" SPA/tests/fixtures/a07/avatar.png
echo 'both-image legacy media recovery, participant access and static denial passed'
