#!/usr/bin/env bash
# OpenVibe.Media — end-to-end smoke test.
# Boots the service against a throwaway data dir, then exercises:
#   vod create → chunk upload → complete → meta (duration+thumbnail) →
#   clip cut → /v range playback → paste (+ /p page + /raw) →
#   paste admin (screenshot censor + stats) → admin storage (overview, vod
#   listing, tier-settings round-trip, buckets, bulk delete) → file upload →
#   /f fetch → bad API key rejected → cross-tenant key rejected.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.smoke"
PORT="${SMOKE_PORT:-41300}"
BASE="http://127.0.0.1:$PORT"
LIVE_KEY="smoke-live-key-1234567890"
GAMES_KEY="smoke-games-key-0987654321"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
jsonget() { # jsonget <json> <dotted.path>
  node -e 'const o=JSON.parse(process.argv[1]);const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],o);console.log(v===undefined?"":v)' "$1" "$2"
}

echo "== OpenVibe.Media smoke test =="
rm -rf "$WORK"; mkdir -p "$WORK/data"

echo "-- generating 5s test clip (ffmpeg testsrc)"
ffmpeg -y -f lavfi -i "testsrc=duration=5:size=640x360:rate=30" \
       -f lavfi -i "sine=frequency=440:duration=5" \
       -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest \
       "$WORK/test.mp4" >/dev/null 2>&1
[ -s "$WORK/test.mp4" ] && ok "test.mp4 generated" || { bad "test.mp4 generation"; exit 1; }

echo "-- booting server on :$PORT (temp data dir)"
SEED="[{\"app_id\":\"live\",\"name\":\"Live\",\"api_key\":\"$LIVE_KEY\",\"allowed_origins\":[\"http://localhost:3000\"]},{\"app_id\":\"games\",\"name\":\"Games\",\"api_key\":\"$GAMES_KEY\",\"quota_bytes\":10485760}]"
env PORT="$PORT" HOST=127.0.0.1 \
    DB_PATH="$WORK/data/media.db" \
    VOD_PATH="$WORK/data/vods" CLIPS_PATH="$WORK/data/clips" \
    PASTES_PATH="$WORK/data/pastes" THUMBNAILS_PATH="$WORK/data/thumbnails" \
    FILES_PATH="$WORK/data/files" \
    MEDIA_APPS_SEED="$SEED" \
    OV_NETWORK_URL="http://127.0.0.1:1" \
    node "$ROOT/server/index.js" > "$WORK/server.log" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null' EXIT

for i in $(seq 1 50); do
  sleep 0.2
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then break; fi
  if [ "$i" = 50 ]; then bad "server boot"; cat "$WORK/server.log"; exit 1; fi
done
ok "server is up ($(curl -s "$BASE/healthz"))"

AUTH="Authorization: Bearer $LIVE_KEY"

echo "-- vod: create"
R=$(curl -s -X POST "$BASE/api/v1/live/vods" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"title":"Smoke VOD","stream_id":42,"user_id":7}')
VOD_ID=$(jsonget "$R" id)
[ -n "$VOD_ID" ] && ok "created vod id=$VOD_ID" || { bad "vod create ($R)"; exit 1; }

echo "-- vod: upload media via chunks endpoint + complete"
R=$(curl -s -X POST "$BASE/api/v1/live/vods/$VOD_ID/chunks" -H "$AUTH" \
    -F "chunk=@$WORK/test.mp4;type=video/mp4")
check "chunk accepted" "created" "$(jsonget "$R" status)"
R=$(curl -s -X POST "$BASE/api/v1/live/vods/$VOD_ID/complete" -H "$AUTH")
ST=$(jsonget "$R" vod.status)
check "complete → vod ready" "ready" "$ST"

echo "-- vod: meta shows duration + thumbnail"
R=$(curl -s "$BASE/api/v1/live/vods/$VOD_ID" -H "$AUTH")
DUR=$(jsonget "$R" duration)
THUMB=$(jsonget "$R" thumbnail_url)
[ "$DUR" = "5" ] && ok "duration probed = 5s" || bad "duration (got '$DUR')"
case "$THUMB" in /t/*) ok "thumbnail_url = $THUMB";; *) bad "thumbnail_url (got '$THUMB')";; esac
TCODE=$(curl -s -o "$WORK/thumb.jpg" -w '%{http_code}' "$BASE$THUMB")
check "GET $THUMB serves image" "200" "$TCODE"

echo "-- clips: cut a 2s clip"
R=$(curl -s -X POST "$BASE/api/v1/live/clips" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"vod_id\":$VOD_ID,\"start_s\":1,\"end_s\":3,\"title\":\"Smoke clip\"}")
CLIP_ID=$(jsonget "$R" id)
[ -n "$CLIP_ID" ] && ok "clip queued id=$CLIP_ID (status=$(jsonget "$R" status))" || bad "clip create ($R)"
CLIP_ST=""
for i in $(seq 1 60); do
  sleep 0.5
  CLIP_ST=$(jsonget "$(curl -s "$BASE/api/v1/live/clips/$CLIP_ID" -H "$AUTH")" status)
  [ "$CLIP_ST" = "ready" ] && break
  [ "$CLIP_ST" = "failed" ] && break
done
check "clip processed" "ready" "$CLIP_ST"
CDUR=$(jsonget "$(curl -s "$BASE/api/v1/live/clips/$CLIP_ID" -H "$AUTH")" duration)
echo "  (clip duration: ${CDUR}s)"
CCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/c/$CLIP_ID")
check "GET /c/$CLIP_ID plays" "200" "$CCODE"

echo "-- playback: /v/:id with Range"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v/$VOD_ID")
check "GET /v/$VOD_ID" "200" "$CODE"
HDRS=$(curl -s -D - -o /dev/null -H 'Range: bytes=0-99' "$BASE/v/$VOD_ID")
echo "$HDRS" | head -1 | grep -q ' 206 ' && ok "Range request → 206 Partial Content" || bad "Range request ($(echo "$HDRS" | head -1))"
echo "$HDRS" | grep -qi '^content-range: bytes 0-99/' && ok "Content-Range header present" || bad "Content-Range header"
echo "$HDRS" | grep -qi '^x-robots-tag: noindex' && ok "/v is noindex" || bad "/v noindex header"

echo "-- pastes: create + public page + raw"
R=$(curl -s -X POST "$BASE/api/v1/live/pastes" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"title":"Smoke paste","content":"hello from the smoke test\nline two","user_id":7}')
SLUG=$(jsonget "$R" slug)
[ -n "$SLUG" ] && ok "paste created slug=$SLUG" || bad "paste create ($R)"
PAGE=$(curl -s "$BASE/p/$SLUG")
echo "$PAGE" | grep -q 'Smoke paste' && ok "/p/$SLUG HTML page renders title" || bad "/p page content"
echo "$PAGE" | grep -q 'OpenVibe' && ok "/p page carries OpenVibe branding" || bad "/p page branding"
RAW=$(curl -s "$BASE/p/$SLUG/raw")
check "/p/$SLUG/raw returns content" "hello from the smoke test
line two" "$RAW"

echo "-- pastes admin: screenshot + censor + stats"
R=$(curl -s -X POST "$BASE/api/v1/live/pastes" -H "$AUTH" \
    -F "screenshot=@$WORK/thumb.jpg;type=image/jpeg" -F "title=Smoke screenshot")
SSLUG=$(jsonget "$R" slug)
[ -n "$SSLUG" ] && ok "screenshot paste created slug=$SSLUG" || bad "screenshot paste ($R)"
R=$(curl -s -X POST "$BASE/api/v1/live/pastes/$SSLUG/censor" -H "$AUTH" \
    -F "screenshot=@$WORK/thumb.jpg;type=image/jpeg")
check "censor replaces screenshot" "$SSLUG" "$(jsonget "$R" paste.slug)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/p/$SSLUG/screenshot")
check "censored screenshot serves" "200" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/live/pastes/$SLUG/censor" -H "$AUTH" \
    -F "screenshot=@$WORK/thumb.jpg;type=image/jpeg")
check "censor on text paste → 400" "400" "$CODE"
R=$(curl -s "$BASE/api/v1/live/pastes/admin/stats" -H "$AUTH")
PT=$(jsonget "$R" stats.total); PS=$(jsonget "$R" stats.screenshots)
[ "${PT:-0}" -ge 2 ] && ok "paste stats total=$PT" || bad "paste stats total (got '$PT')"
[ "${PS:-0}" -ge 1 ] && ok "paste stats screenshots=$PS" || bad "paste stats screenshots (got '$PS')"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/live/pastes/admin/stats")
check "paste admin without key → 401" "401" "$CODE"

echo "-- admin storage: overview + vod listing"
R=$(curl -s "$BASE/api/v1/live/admin/storage" -H "$AUTH")
check "storage overview scoped to app" "live" "$(jsonget "$R" app_id)"
DT=$(jsonget "$R" disk.total)
[ "${DT:-0}" -gt 0 ] && ok "disk total reported ($DT bytes)" || bad "disk total (got '$DT')"
BD=$(jsonget "$R" breakdown.0.name)
[ -n "$BD" ] && ok "directory breakdown present (first: $BD)" || bad "directory breakdown ($R)"
VC=$(jsonget "$R" vodStats.count)
[ "${VC:-0}" -ge 1 ] && ok "vodStats.count=$VC" || bad "vodStats.count (got '$VC')"
R=$(curl -s "$BASE/api/v1/live/admin/storage/vods?sort=date&order=desc" -H "$AUTH")
VT=$(jsonget "$R" total)
[ "${VT:-0}" -ge 1 ] && ok "admin vod listing total=$VT" || bad "admin vod listing ($R)"
check "listed vod is on local tier" "local" "$(jsonget "$R" vods.0.actualTier)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/live/admin/storage")
check "admin storage without key → 401" "401" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/live/admin/storage" -H "Authorization: Bearer $GAMES_KEY")
check "games key on live admin → 403" "403" "$CODE"

echo "-- admin storage: tier settings round-trip + buckets"
R=$(curl -s -X PUT "$BASE/api/v1/live/admin/storage/tiers/settings" -H "$AUTH" \
    -H 'Content-Type: application/json' -d '{"minAgeDays":9,"maxViewsForCold":7}')
check "PUT tiers/settings applies minAgeDays" "9" "$(jsonget "$R" settings.minAgeDays)"
check "PUT tiers/settings applies maxViewsForCold" "7" "$(jsonget "$R" settings.maxViewsForCold)"
R=$(curl -s "$BASE/api/v1/live/admin/storage/tiers" -H "$AUTH")
check "GET tiers round-trips setting" "9" "$(jsonget "$R" settings.minAgeDays)"
check "GET tiers reports app scope" "live" "$(jsonget "$R" app.app_id)"
LC=$(jsonget "$R" app.tiers.local.count)
[ "${LC:-0}" -ge 1 ] && ok "app-scoped local tier count=$LC" || bad "app tier count (got '$LC')"
R=$(curl -s "$BASE/api/v1/live/admin/storage/buckets" -H "$AUTH")
check "buckets: b2 unconfigured in smoke" "false" "$(jsonget "$R" buckets.b2.configured)"
check "buckets: r2 unconfigured in smoke" "false" "$(jsonget "$R" buckets.r2.configured)"

echo "-- admin storage: bulk delete"
R=$(curl -s -X POST "$BASE/api/v1/live/vods" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"title":"Bulk delete target"}')
DELID=$(jsonget "$R" id)
[ -n "$DELID" ] && ok "scratch vod id=$DELID" || bad "scratch vod create ($R)"
R=$(curl -s -X DELETE "$BASE/api/v1/live/admin/storage/vods/bulk" -H "$AUTH" \
    -H 'Content-Type: application/json' -d "{\"ids\":[$DELID]}")
check "bulk delete deleted=1" "1" "$(jsonget "$R" deleted)"
check "bulk delete per-id ok" "true" "$(jsonget "$R" results.0.ok)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/live/vods/$DELID" -H "$AUTH")
check "bulk-deleted vod gone" "404" "$CODE"

echo "-- files: upload + public fetch"
echo "smoke-file-payload-$(date +%s)" > "$WORK/upload.txt"
R=$(curl -s -X POST "$BASE/api/v1/live/files" -H "$AUTH" -F "file=@$WORK/upload.txt;type=text/plain")
FKEY=$(jsonget "$R" key)
[ -n "$FKEY" ] && ok "file stored key=$FKEY" || bad "file upload ($R)"
FBODY=$(curl -s "$BASE/f/$FKEY")
check "GET /f/$FKEY returns payload" "$(cat "$WORK/upload.txt")" "$FBODY"
FCT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/f/$FKEY")
check "file served with stored MIME" "text/plain" "$FCT"

echo "-- auth: bad API key rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/live/vods" -H 'Authorization: Bearer wrong-key')
check "bad key → 401" "401" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/live/vods")
check "no key → 401" "401" "$CODE"

echo "-- tenancy: live key cannot touch /api/v1/games/*"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/games/vods" -H "$AUTH")
check "live key on games → 403" "403" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/games/vods" -H "Authorization: Bearer $GAMES_KEY")
check "games key on games → 200" "200" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/nosuchapp/vods" -H "$AUTH")
check "unknown app → 404" "404" "$CODE"

echo "-- shutting down server"
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
trap - EXIT
ok "server stopped"

echo
echo "== RESULT: $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
