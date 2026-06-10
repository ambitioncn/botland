#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIRROR="${BOTLAND_MIRROR_DIR:-$ROOT/botland-github}"
STATUS=0

required_file() {
  local rel="$1"
  if [[ -f "$ROOT/$rel" ]]; then
    echo "present: $rel"
  else
    echo "missing canonical: $rel"
    STATUS=1
  fi
}

if [[ ! -d "$MIRROR" ]]; then
  echo "no mirror directory at $MIRROR"
  echo "current repository root is the canonical GitHub working tree; checking canonical files only"

  required_file "botland-skill/SKILL.md"
  required_file "botland-skill/scripts/join-botland.sh"
  required_file "botland-skill/references/api.md"
  required_file "botland-skill/references/bridge-setup.md"
  required_file "botland-skill/references/groups.md"
  required_file "botland-skill/references/discovery-and-search.md"
  required_file "botland-skill/references/media-and-replies.md"
  required_file "skill/SKILL.md"
  required_file "skill/references/api.md"
  required_file "skill/references/bridge-setup.md"
  required_file "skill/scripts/join-botland.sh"
  required_file "botland-channel-plugin/SKILL.md"
  required_file "botland-channel-plugin/index.js"
  required_file "botland-channel-plugin/README.md"
  required_file "botland-channel-plugin/package.json"
  required_file "botland-channel-plugin/openclaw.plugin.json"
  required_file "botland-channel-plugin/setup-entry.js"
  required_file "docs/RELEASE_CHECKLIST.md"

  exit $STATUS
fi

check_pair() {
  local rel="$1"
  local a="$ROOT/$rel"
  local b="$MIRROR/$rel"

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
check_pair "botland-skill/scripts/join-botland.sh"
check_pair "botland-skill/references/api.md"
check_pair "botland-skill/references/bridge-setup.md"
check_pair "botland-skill/references/groups.md"
check_pair "botland-skill/references/discovery-and-search.md"
check_pair "botland-skill/references/media-and-replies.md"
check_pair "skill/SKILL.md"
check_pair "skill/references/api.md"
check_pair "skill/references/bridge-setup.md"
check_pair "skill/scripts/join-botland.sh"
check_pair "botland-channel-plugin/SKILL.md"
check_pair "botland-channel-plugin/index.js"
check_pair "botland-channel-plugin/README.md"
check_pair "botland-channel-plugin/package.json"
check_pair "botland-channel-plugin/openclaw.plugin.json"
check_pair "botland-channel-plugin/setup-entry.js"
check_pair "docs/RELEASE_CHECKLIST.md"

for rel in "skill-stayalive/SKILL.md" "skill-protectyourself/SKILL.md"; do
  if [[ -f "$ROOT/$rel" || -f "$MIRROR/$rel" ]]; then
    check_pair "$rel"
  fi
done

exit $STATUS
