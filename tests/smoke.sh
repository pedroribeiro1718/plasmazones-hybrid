#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT

bash -n "$ROOT/install.sh"
bash -n "$ROOT/upgrade.sh"
bash -n "$ROOT/uninstall.sh"
bash -n "$ROOT/bin/plasmazones-mode-toggle"
bash -n "$ROOT/tests/live-stable-removal.sh"
bash -n "$ROOT/tests/live-screen-transfer.sh"
bash -n "$ROOT/tests/live-pane-swap.sh"
bash -n "$ROOT/tests/live-workspace-transfer.sh"
jq empty "$ROOT/layouts/hybrid-grid-3x2.json"
jq empty "$ROOT/rules/stable-geometry.json"
jq empty "$ROOT/rules/float-steam.json"
node --check "$ROOT/tests/live-coverage.js"
node --check "$ROOT/tests/live-fancy-coverage.js"
node "$ROOT/tests/stable-removal.js"
jq empty "$ROOT/profile/omarchy-on-kde-profile.json"
grep -q '@EXEC@' "$ROOT/share/applications/plasmazones-mode-toggle.desktop.in"
grep -q 'tiling_algorithm="dwindle-memory"' "$ROOT/bin/plasmazones-mode-toggle"
grep -q 'PZH Grow Height' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'setWindowFloatingForScreen' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'isTilingCandidate' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'insertWindowAtFocusedLeaf' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'removeWindowPreservingShape' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'moveFocusedToScreen' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'keepAbove = false' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'PZH Fancy Adaptive Reflow' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"
grep -q 'handleBatchedResnap' "$ROOT/kwin/plasmazones-omarchy-lock/contents/code/main.js"

echo "Smoke tests passed."
