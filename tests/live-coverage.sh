#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_ID="pzh-live-coverage"
SAMPLES="${1:-1}"

command -v qdbus6 >/dev/null
command -v journalctl >/dev/null

status="$("$ROOT/bin/plasmazones-mode-toggle" status)"
if ! grep -q 'Omarchy' <<<"$status"; then
    echo "Live coverage is only meaningful in Omarchy mode." >&2
    exit 2
fi
screen_count="$(wc -l <<<"$status")"

for ((sample = 1; sample <= SAMPLES; sample++)); do
    qdbus6 org.kde.KWin /Scripting \
        org.kde.kwin.Scripting.unloadScript "$SCRIPT_ID" >/dev/null 2>&1 || true
    qdbus6 org.kde.KWin /Scripting \
        org.kde.kwin.Scripting.loadScript "$ROOT/tests/live-coverage.js" \
        "$SCRIPT_ID" >/dev/null
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null

    sleep 0.15
    result="$(journalctl --user -u plasma-kwin_wayland --since '2 seconds ago' \
        --no-pager | grep 'PZH_LIVE_COVERAGE' | tail -n "$screen_count")"
    printf 'sample %d/%d\n%s\n' "$sample" "$SAMPLES" "$result"
    [[ "$(wc -l <<<"$result")" -eq "$screen_count" ]]
    grep -q 'PZH_LIVE_COVERAGE PASS' <<<"$result"
    if grep -q 'PZH_LIVE_COVERAGE FAIL' <<<"$result"; then
        exit 1
    fi
done
