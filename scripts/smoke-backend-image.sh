#!/usr/bin/env bash
set -euo pipefail

image="${1:-social-network-backend}"
name="sn-b06-smoke-$$"
volume="sn-b06-smoke-data-$$"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

python3 - "$work/avatar.png" <<'PY'
import struct, sys, zlib
def chunk(kind, payload):
    return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', zlib.crc32(kind + payload) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
PY

start() {
  docker run -d --name "$name" -p 127.0.0.1::8080 \
    -v "$volume:/data" -e FRONTEND_URL=http://localhost:3000 "$image" >/dev/null
  local port
  port="$(docker port "$name" 8080/tcp | sed 's/.*://')"
  base="http://127.0.0.1:$port"
  for _ in {1..40}; do
    if curl -fsS "$base/api/v1/health" >/dev/null 2>&1; then return; fi
    sleep 0.25
  done
  docker logs "$name"
  echo "backend did not become ready" >&2
  exit 1
}

start
curl -fsS -c "$work/cookies" -o "$work/register.json" \
  -H 'Origin: http://localhost:3000' -H 'X-Requested-With: XMLHttpRequest' \
  -F email=avatar@example.com -F password='correct horse battery' \
  -F first_name=Avatar -F last_name=Owner -F date_of_birth=2000-01-01 \
  -F "avatar=@$work/avatar.png;type=image/png" "$base/api/v1/users/register"
avatar_path="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["avatar_url"])' < "$work/register.json")"
curl -fsS -b "$work/cookies" "$base$avatar_path" -o "$work/read.png"
cmp "$work/avatar.png" "$work/read.png"
curl -fsS -b "$work/cookies" "$base/api/v1/users/me" | python3 -c 'import json,sys; assert json.load(sys.stdin)["data"]["email"] == "avatar@example.com"'

docker rm -f "$name" >/dev/null
start
curl -fsS -b "$work/cookies" "$base/api/v1/users/me" | python3 -c 'import json,sys; assert json.load(sys.stdin)["data"]["email"] == "avatar@example.com"'
curl -fsS -b "$work/cookies" "$base$avatar_path" -o "$work/read-after-restart.png"
cmp "$work/avatar.png" "$work/read-after-restart.png"
curl -fsS -b "$work/cookies" -c "$work/cookies" -o "$work/logout.json" \
  -H 'Origin: http://localhost:3000' -H 'X-Requested-With: XMLHttpRequest' \
  -X POST "$base/api/v1/users/logout"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["data"]["message"] == "Logged out"' "$work/logout.json"
curl -fsS -c "$work/cookies" -o "$work/login.json" \
  -H 'Origin: http://localhost:3000' -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Content-Type: application/json' \
  -d '{"email":"avatar@example.com","password":"correct horse battery"}' \
  "$base/api/v1/users/login"
curl -fsS -b "$work/cookies" "$base/api/v1/users/me" | python3 -c 'import json,sys; assert json.load(sys.stdin)["data"]["avatar_url"]'

docker rm -f "$name" >/dev/null
if docker run --rm -e DB_PATH=/data -v "$volume:/data" "$image" >/dev/null 2>&1; then
  echo "invalid database path unexpectedly started" >&2
  exit 1
fi
if docker run --rm -e MEDIA_ROOT=/proc/avatar-test "$image" >/dev/null 2>&1; then
  echo "invalid media storage unexpectedly started" >&2
  exit 1
fi
echo "backend image smoke passed"
