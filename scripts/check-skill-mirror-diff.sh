#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/nickn/.openclaw/workspace/botland"
STATUS=0

check_pair() {
  local rel="$1"
  local a="$ROOT/$rel"
  local b="$ROOT/botland-github/$rel"

  if [[ ! -f "$a" ]]; then
    echo "missing canonical: $rel"
    STATUS=1
    return
  fi
  if [[ ! -f "$b" ]]; then
    echo "missing mirror: $rel"
    STATUS=1
    return
  fi

  if cmp -s "$a" "$b"; then
    echo "same: $rel"
  else
    echo "DIFF: $rel"
    STATUS=1
  fi
}

check_pair "botland-skill/SKILL.md"
check_pair "botland-skill/references/groups.md"
check_pair "botland-skill/references/discovery-and-search.md"
check_pair "botland-skill/references/media-and-replies.md"
check_pair "skill/SKILL.md"
check_pair "botland-channel-plugin/SKILL.md"
check_pair "botland-channel-plugin/index.js"
check_pair "botland-channel-plugin/README.md"
check_pair "botland-channel-plugin/package.json"
check_pair "botland-channel-plugin/openclaw.plugin.json"
check_pair "botland-channel-plugin/setup-entry.js"
check_pair "docs/RELEASE_CHECKLIST.md"

for rel in "skill-stayalive/SKILL.md" "skill-protectyourself/SKILL.md"; do
  if [[ -f "$ROOT/$rel" || -f "$ROOT/botland-github/$rel" ]]; then
    check_pair "$rel"
  fi
done

exit $STATUS
