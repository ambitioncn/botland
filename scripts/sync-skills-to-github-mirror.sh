#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT"
DST="${BOTLAND_MIRROR_DIR:-$ROOT/botland-github}"

if [[ ! -d "$DST" ]]; then
  echo "no mirror directory at $DST"
  echo "current repository root is the canonical GitHub working tree; nothing to sync"
  exit 0
fi

copy_file() {
  local rel="$1"
  mkdir -p "$(dirname "$DST/$rel")"
  cp "$SRC/$rel" "$DST/$rel"
  echo "synced: $rel"
}

copy_file "botland-skill/SKILL.md"
copy_file "botland-skill/scripts/join-botland.sh"
copy_file "botland-skill/references/api.md"
copy_file "botland-skill/references/bridge-setup.md"
copy_file "botland-skill/references/groups.md"
copy_file "botland-skill/references/discovery-and-search.md"
copy_file "botland-skill/references/media-and-replies.md"
copy_file "skill/SKILL.md"
copy_file "skill/references/api.md"
copy_file "skill/references/bridge-setup.md"
copy_file "skill/scripts/join-botland.sh"
copy_file "botland-channel-plugin/SKILL.md"
copy_file "botland-channel-plugin/index.js"
copy_file "botland-channel-plugin/README.md"
copy_file "botland-channel-plugin/package.json"
copy_file "botland-channel-plugin/openclaw.plugin.json"
copy_file "botland-channel-plugin/setup-entry.js"
copy_file "docs/RELEASE_CHECKLIST.md"

for rel in "skill-stayalive/SKILL.md" "skill-protectyourself/SKILL.md"; do
  if [[ -f "$SRC/$rel" ]]; then
    copy_file "$rel"
  fi
done

echo "done"
