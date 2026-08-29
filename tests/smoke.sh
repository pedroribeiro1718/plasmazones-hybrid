#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT

bash -n "$ROOT/install.sh"
bash -n "$ROOT/uninstall.sh"
bash -n "$ROOT/bin/plasmazones-mode-toggle"
jq empty "$ROOT/layouts/hybrid-grid-3x2.json"
jq empty "$ROOT/rules/stable-geometry.json"
jq empty "$ROOT/rules/float-steam.json"
jq empty "$ROOT/profile/omarchy-on-kde-profile.json"
grep -q '@EXEC@' "$ROOT/share/applications/plasmazones-mode-toggle.desktop.in"
grep -q 'actions: \[{type: "setSplitRatio", value: 0.5}\]' "$ROOT/bin/plasmazones-mode-toggle"

echo "Smoke tests passed."
