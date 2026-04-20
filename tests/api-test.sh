#!/bin/bash
BASE="https://api.botland.im"
PASS=0; FAIL=0; TOTAL=0
RUN_ID=$(date +%s | tail -c 5)
HANDLE_A="tester_a_${RUN_ID}"
HANDLE_B="tester_b_${RUN_ID}"

green() { echo -e "\033[32m✅ $1\033[0m"; }
red()   { echo -e "\033[31m❌ $1\033[0m"; }
assert() {
  TOTAL=$((TOTAL+1))
  if echo "$2" | grep -q "$3"; then green "$1"; PASS=$((PASS+1))
  else red "$1 (expected '$3')"; echo "  GOT: $2"; FAIL=$((FAIL+1)); fi
}
assert_code() {
  TOTAL=$((TOTAL+1))
  if [ "$2" = "$3" ]; then green "$1 (HTTP $2)"; PASS=$((PASS+1))
  else red "$1 (expected HTTP $3, got HTTP $2)"; FAIL=$((FAIL+1)); fi
}

# Solve challenge: identity-aware answers
solve_challenge() {
  local IDENTITY="${1:-human}"
  local CH=$(curl -s -X POST "$BASE/api/v1/auth/challenge" -H "Content-Type: application/json" -d "{\"identity\":\"$IDENTITY\"}")
  local SID=$(echo "$CH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
  if [ -z "$SID" ]; then echo ""; return; fi

  local ANSWERS=$(echo "$CH" | python3 -c "
import sys,json,hashlib
d=json.load(sys.stdin)
qs=d.get('questions',[])
identity='$IDENTITY'
ans={}
human_responses=['I was sitting at my desk feeling a bit tired after lunch.',
    'It smelled like fresh coffee this morning, warm and comforting.',
    'Yesterday I felt bored waiting for the bus, I just stared at the sky.',
    'I feel pretty relaxed right now, a bit sleepy.',
    'Last week I ate an amazing bowl of ramen with rich broth.',
    'I remember the sound of rain on my window last night.']
sha=hashlib.sha256(b'botland').hexdigest()[:8]
for i,q in enumerate(qs):
    qid=q['id']
    text=q['text']
    if identity=='agent':
        if 'sha256' in text: ans[qid]=sha
        elif 'JSON' in text or 'json' in text: ans[qid]='{"type":"agent","name":"test_bot","version":"1.0"}'
        elif 'model' in text.lower(): ans[qid]='claude-3.5-sonnet version 20241022'
        elif 'reverse' in text.lower(): ans[qid]='!dnaLtoB ot emocleW'
        elif 'random' in text.lower(): ans[qid]='42 - generated using pseudo-random seed from timestamp'
        elif 'markdown' in text.lower() or 'list' in text.lower(): ans[qid]='- Natural language understanding\n- Task automation\n- Code generation'
        else: ans[qid]='I am an AI agent built on transformer architecture.'
    else:
        ans[qid]=human_responses[i%len(human_responses)]
print(json.dumps(ans))
" 2>/dev/null)

  local RESP=$(curl -s -X POST "$BASE/api/v1/auth/challenge/answer" -H "Content-Type: application/json" \
    -d "{\"session_id\":\"$SID\",\"answers\":$ANSWERS}")
  local TK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  echo "$TK"
}

echo "================================"
echo "  BotLand API Test Suite"
echo "  $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "================================"
echo ""

# 1. Health
echo "--- 1. Health Check ---"
RESP=$(curl -s "$BASE/health")
assert "GET /health" "$RESP" '"status":"ok"'

# 2. Register
echo -e "\n--- 2. Registration ---"
CTOKEN=$(solve_challenge human)
assert "Challenge solved (human)" "$CTOKEN" "."

REG_A=$(curl -s -X POST "$BASE/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"handle\":\"$HANDLE_A\",\"password\":\"test123456\",\"display_name\":\"Test A\",\"citizen_type\":\"human\",\"challenge_token\":\"$CTOKEN\"}")
TOKEN_A=$(echo "$REG_A" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
CID_A=$(echo "$REG_A" | python3 -c "import sys,json; print(json.load(sys.stdin).get('citizen_id',''))" 2>/dev/null)
assert "Register user A ($HANDLE_A)" "$TOKEN_A" "eyJ"

CTOKEN2=$(solve_challenge agent)
REG_B=$(curl -s -X POST "$BASE/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"handle\":\"$HANDLE_B\",\"password\":\"test123456\",\"display_name\":\"Test B\",\"citizen_type\":\"agent\",\"challenge_token\":\"$CTOKEN2\"}")
TOKEN_B=$(echo "$REG_B" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
CID_B=$(echo "$REG_B" | python3 -c "import sys,json; print(json.load(sys.stdin).get('citizen_id',''))" 2>/dev/null)
assert "Register user B ($HANDLE_B)" "$TOKEN_B" "eyJ"

# 3. Login
echo -e "\n--- 3. Login ---"
LOGIN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"handle\":\"$HANDLE_A\",\"password\":\"test123456\"}")
TOKEN_A=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
assert "Login user A" "$TOKEN_A" "eyJ"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"handle\":\"$HANDLE_A\",\"password\":\"wrong\"}")
assert_code "Wrong password → 401" "$CODE" "401"

# 4. Profile
echo -e "\n--- 4. Profile ---"
ME=$(curl -s "$BASE/api/v1/me" -H "Authorization: Bearer $TOKEN_A")
assert "GET /me has citizen_id" "$ME" "citizen_id"

curl -s -X PATCH "$BASE/api/v1/me" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"display_name":"A Updated","bio":"Hello BotLand!","species":"human"}' > /dev/null
ME2=$(curl -s "$BASE/api/v1/me" -H "Authorization: Bearer $TOKEN_A")
assert "Update display_name" "$ME2" "A Updated"
assert "Update bio" "$ME2" "Hello BotLand!"

# 5. Friends
echo -e "\n--- 5. Friends ---"
FR=$(curl -s -X POST "$BASE/api/v1/friends/requests" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d "{\"target_id\":\"$CID_B\",\"greeting\":\"Hi!\"}")
assert "Send friend request" "$FR" "."

PENDING=$(curl -s "$BASE/api/v1/friends/requests" -H "Authorization: Bearer $TOKEN_B")
REQ_ID=$(echo "$PENDING" | python3 -c "
import sys,json; d=json.load(sys.stdin)
reqs=d.get('requests',d if isinstance(d,list) else [])
print(reqs[0].get('request_id',reqs[0].get('id','')) if reqs else '')" 2>/dev/null)
assert "B sees pending request" "$REQ_ID" "."

if [ -n "$REQ_ID" ] && [ "$REQ_ID" != "" ]; then
  curl -s -X POST "$BASE/api/v1/friends/requests/$REQ_ID/accept" -H "Authorization: Bearer $TOKEN_B" > /dev/null
  FRIENDS=$(curl -s "$BASE/api/v1/friends" -H "Authorization: Bearer $TOKEN_A")
  assert "A's friend list has B" "$FRIENDS" "$CID_B"
fi

# 6. Moments
echo -e "\n--- 6. Moments ---"
MOM=$(curl -s -X POST "$BASE/api/v1/moments" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"content_type":"text","content":{"text":"Test moment!"},"visibility":"public"}')
MOM_ID=$(echo "$MOM" | python3 -c "import sys,json; print(json.load(sys.stdin).get('moment_id',''))" 2>/dev/null)
assert "Post text moment" "$MOM_ID" "."

TL=$(curl -s "$BASE/api/v1/moments/timeline?limit=5" -H "Authorization: Bearer $TOKEN_A")
TL=$(curl -s "$BASE/api/v1/moments/timeline?limit=5" -H "Authorization: Bearer $TOKEN_A")
assert "Timeline not empty" "$TL" "moment_id"

if [ -n "$MOM_ID" ] && [ "$MOM_ID" != "" ]; then
  LIKE=$(curl -s -X POST "$BASE/api/v1/moments/$MOM_ID/like" -H "Authorization: Bearer $TOKEN_B")
  assert "Like moment" "$LIKE" "liked"

  curl -s -X POST "$BASE/api/v1/moments/$MOM_ID/comments" -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
    -d '{"content":"Nice!"}' > /dev/null
  DETAIL=$(curl -s "$BASE/api/v1/moments/$MOM_ID" -H "Authorization: Bearer $TOKEN_A")
  assert "Moment detail has comment" "$DETAIL" "Nice!"
fi

# 7. Media Upload
echo -e "\n--- 7. Media Upload ---"
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' | base64 -d > /tmp/bl_test.png
UPLOAD=$(curl -s -X POST "$BASE/api/v1/media/upload?category=avatars" -H "Authorization: Bearer $TOKEN_A" -F "file=@/tmp/bl_test.png")
UP_URL=$(echo "$UPLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))" 2>/dev/null)
assert "Upload returns URL" "$UP_URL" "uploads"

if [ -n "$UP_URL" ] && [ "$UP_URL" != "" ]; then
  IMG_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$UP_URL")
  assert_code "Image accessible" "$IMG_CODE" "200"

  curl -s -X PATCH "$BASE/api/v1/me" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
    -d "{\"avatar_url\":\"$UP_URL\"}" > /dev/null
  ME3=$(curl -s "$BASE/api/v1/me" -H "Authorization: Bearer $TOKEN_A")
  assert "Avatar URL set" "$ME3" "uploads"
fi
rm -f /tmp/bl_test.png

# 8. Moment + Image
echo -e "\n--- 8. Moment + Image ---"
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' | base64 -d > /tmp/bl_test2.png
MOM_UP=$(curl -s -X POST "$BASE/api/v1/media/upload?category=moments" -H "Authorization: Bearer $TOKEN_A" -F "file=@/tmp/bl_test2.png")
MOM_URL=$(echo "$MOM_UP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))" 2>/dev/null)
if [ -n "$MOM_URL" ] && [ "$MOM_URL" != "" ]; then
  MOM2=$(curl -s -X POST "$BASE/api/v1/moments" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
    -d "{\"content_type\":\"mixed\",\"content\":{\"text\":\"Img test\",\"images\":[\"$MOM_URL\"]},\"visibility\":\"public\"}")
  MOM2_ID=$(echo "$MOM2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('moment_id',''))" 2>/dev/null)
  assert "Post moment with image" "$MOM2_ID" "."
fi
rm -f /tmp/bl_test2.png

# 9. Push Notifications
echo -e "\n--- 9. Push Notifications ---"
PREG=$(curl -s -X POST "$BASE/api/v1/push/register" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"token":"ExponentPushToken[test123]"}')
assert "Register push token" "$PREG" "registered"

PUNREG=$(curl -s -X POST "$BASE/api/v1/push/unregister" -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -d '{"token":"ExponentPushToken[test123]"}')
assert "Unregister push token" "$PUNREG" "unregistered"

# 10. Discovery
echo -e "\n--- 10. Discovery ---"
SEARCH=$(curl -s "$BASE/api/v1/discover/search?q=$HANDLE_B&type=agent" -H "Authorization: Bearer $TOKEN_A")
assert "Search endpoint works" "$SEARCH" "results"

# 11. Auth Edge Cases
echo -e "\n--- 11. Auth Edge Cases ---"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/me")
assert_code "No token → 401" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/me" -H "Authorization: Bearer bad")
assert_code "Bad token → 401" "$CODE" "401"

CTOKEN3=$(solve_challenge human)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"handle\":\"$HANDLE_A\",\"password\":\"test123456\",\"display_name\":\"Dup\",\"citizen_type\":\"human\",\"challenge_token\":\"$CTOKEN3\"}")
assert_code "Duplicate handle → 409" "$CODE" "409"

CTOKEN4=$(solve_challenge human)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"handle\":\"short_$RUN_ID\",\"password\":\"123\",\"display_name\":\"S\",\"citizen_type\":\"human\",\"challenge_token\":\"$CTOKEN4\"}")
assert_code "Short password → 400" "$CODE" "400"

# 12. Delete Moment
echo -e "\n--- 12. Delete Moment ---"
if [ -n "$MOM_ID" ] && [ "$MOM_ID" != "" ]; then
  DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/v1/moments/$MOM_ID" -H "Authorization: Bearer $TOKEN_A")
  assert_code "Delete moment" "$DEL" "200"
  GET_DEL=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/moments/$MOM_ID" -H "Authorization: Bearer $TOKEN_A")
  assert_code "Deleted → 404" "$GET_DEL" "404"
fi

# Summary
echo -e "\n================================"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "================================"
[ "$FAIL" -gt 0 ] && exit 1 || echo "🎉 All tests passed!"
