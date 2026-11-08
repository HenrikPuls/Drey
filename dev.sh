#!/usr/bin/env bash
# Linux/macOS counterpart of dev.ps1: installs dependencies when missing,
# then starts the app. Uses the Node on PATH (or .tools/node when present).
#
#   ./dev.sh            dev server + Electron (hot reload, DevTools)
#   ./dev.sh --built    npm run app (fresh production build, packaged-style)
#   ./dev.sh --multi    combinable: opt out of the single-instance lock
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

[ -d .tools/node ] && export PATH="$root/.tools/node:$PATH"
command -v node >/dev/null || { echo "node (>=24) not found on PATH" >&2; exit 1; }
[ -d node_modules ] || npm ci

mode=dev
for arg in "$@"; do
  case "$arg" in
    --built) mode=app ;;
    --multi) export DREY_MULTI_INSTANCE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
exec npm run "$mode"
