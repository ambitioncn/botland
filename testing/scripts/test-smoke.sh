#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS="$ROOT/artifacts"
UI_DIR="$ROOT/ui"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$ARTIFACTS/smoke-$TS"
mkdir -p "$RUN_DIR"

echo "[smoke] artifacts: $RUN_DIR"

echo "[smoke] protocol core-dm"
node "$ROOT/run-all.js" --suite core-dm --json-out "$RUN_DIR/protocol-core-dm.json"

echo "[smoke] protocol group-core"
node "$ROOT/run-all.js" --suite group-core --json-out "$RUN_DIR/protocol-group-core.json"

echo "[smoke] ui dm"
(
  cd "$UI_DIR"
  npx playwright test --workers=1 specs/typing.spec.ts specs/reply-preview.spec.ts specs/reaction.spec.ts \
    --reporter=list,json \
    --output "$RUN_DIR/ui-dm-results" \
    > "$RUN_DIR/ui-dm.log"
)

UI_DM_JSON_SRC="$UI_DIR/test-results/.last-run.json"
if [[ -f "$UI_DM_JSON_SRC" ]]; then
  cp "$UI_DM_JSON_SRC" "$RUN_DIR/ui-dm-last-run.json"
fi

echo "[smoke] ui group"
(
  cd "$UI_DIR"
  npx playwright test --workers=1 specs/group-mention.spec.ts specs/group-typing.spec.ts specs/group-reaction.spec.ts \
    --reporter=list,json \
    --output "$RUN_DIR/ui-group-results" \
    > "$RUN_DIR/ui-group.log"
)

if [[ -f "$UI_DM_JSON_SRC" ]]; then
  cp "$UI_DM_JSON_SRC" "$RUN_DIR/ui-group-last-run.json"
fi

cat > "$RUN_DIR/README.txt" <<TXT
BotLand smoke run

Timestamp: $TS
Contents:
- protocol-core-dm.json
- protocol-group-core.json
- ui-dm.log
- ui-group.log
- ui-dm-results/
- ui-group-results/
- ui-dm-last-run.json (if Playwright emitted it)
- ui-group-last-run.json (if Playwright emitted it)
TXT

echo "[smoke] done: $RUN_DIR"
