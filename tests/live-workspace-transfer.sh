#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly TITLE="PZH-WORKSPACE-TRANSFER"
ORIGINAL_DESKTOP="$(kdotool get_desktop)"
readonly ORIGINAL_DESKTOP
if [[ "$ORIGINAL_DESKTOP" == "4" ]]; then
    readonly TARGET_DESKTOP=1
else
    readonly TARGET_DESKTOP=4
fi
window_id=""
konsole_pid=""

cleanup() {
    if [[ -n "$window_id" ]]; then
        kdotool windowclose "$window_id" >/dev/null 2>&1 || true
    fi
    if [[ -n "$konsole_pid" ]]; then
        kill "$konsole_pid" >/dev/null 2>&1 || true
    fi
    kdotool set_desktop "$ORIGINAL_DESKTOP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

invoke_workspace() {
    qdbus6 org.kde.kglobalaccel /component/kwin \
        org.kde.kglobalaccel.Component.invokeShortcut \
        "PZH Move to Workspace $1" >/dev/null
    sleep 0.45
}

grep -q 'Omarchy' < <("$ROOT/bin/plasmazones-mode-toggle" status) || {
    echo "Live workspace-transfer testing requires Omarchy mode." >&2
    exit 2
}
konsole --separate -p "LocalTabTitleFormat=${TITLE}" \
    -p "tabtitle=${TITLE}" --hold -e /usr/bin/sleep 120 &
konsole_pid="$!"
for _ in {1..50}; do
    window_id="$(kdotool search --name "^${TITLE}.*Konsole$" \
        getwindowid %1 2>/dev/null || true)"
    [[ -z "$window_id" ]] || break
    sleep 0.1
done
[[ -n "$window_id" ]]
kdotool windowactivate "$window_id" >/dev/null
sleep 0.35

invoke_workspace "$TARGET_DESKTOP"
[[ "$(kdotool get_desktop)" == "$TARGET_DESKTOP" ]]
[[ "$(kdotool get_desktop_for_window "$window_id")" == "$TARGET_DESKTOP" ]]
"$ROOT/tests/live-coverage.sh" 3

invoke_workspace "$ORIGINAL_DESKTOP"
[[ "$(kdotool get_desktop)" == "$ORIGINAL_DESKTOP" ]]
[[ "$(kdotool get_desktop_for_window "$window_id")" == "$ORIGINAL_DESKTOP" ]]
"$ROOT/tests/live-coverage.sh" 3

printf 'Live workspace transfer passed: desktop %s -> %s -> %s.\n' \
    "$ORIGINAL_DESKTOP" "$TARGET_DESKTOP" "$ORIGINAL_DESKTOP"
