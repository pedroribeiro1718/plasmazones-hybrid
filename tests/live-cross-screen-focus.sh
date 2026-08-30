#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly TEST_DESKTOP="${PZH_TEST_DESKTOP:-4}"
ORIGINAL_DESKTOP="$(kdotool get_desktop)"
readonly ORIGINAL_DESKTOP
declare -a IDS=()
declare -a PIDS=()

cleanup() {
    local id pid
    for id in "${IDS[@]}"; do
        kdotool windowclose "$id" >/dev/null 2>&1 || true
    done
    for pid in "${PIDS[@]}"; do
        kill "$pid" >/dev/null 2>&1 || true
    done
    kdotool set_desktop "$ORIGINAL_DESKTOP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

invoke() {
    qdbus6 org.kde.kglobalaccel /component/kwin \
        org.kde.kglobalaccel.Component.invokeShortcut "$1" >/dev/null
    sleep 0.45
}

active_window() {
    kdotool getactivewindow getwindowid %1
}

geometry() {
    kdotool getwindowgeometry "$1" | awk '
        /Position:/ {gsub(/,/, " ", $2); x=$2; y=$3}
        /Geometry:/ {print x, y, $2}'
}

launch() {
    local side="$1" title id=""
    title="PZH-CROSS-FOCUS-${side}"
    konsole --separate -p "LocalTabTitleFormat=${title}" \
        -p "tabtitle=${title}" --hold -e /usr/bin/sleep 120 &
    PIDS+=("$!")
    for _ in {1..50}; do
        id="$(kdotool search --name "^${title}.*Konsole$" \
            getwindowid %1 2>/dev/null || true)"
        [[ -z "$id" ]] || break
        sleep 0.1
    done
    [[ -n "$id" ]]
    IDS+=("$id")
    kdotool windowactivate "$id" >/dev/null
    sleep 0.35
}

grep -q 'Omarchy' < <("$ROOT/bin/plasmazones-mode-toggle" status) || {
    echo "Live cross-screen focus testing requires Omarchy mode." >&2
    exit 2
}

kdotool set_desktop "$TEST_DESKTOP" >/dev/null
sleep 0.35

launch TOP_LEFT
invoke "PZH Send to Screen Left"
top_left_id="${IDS[0]}"

launch LOCAL_RIGHT
invoke "PZH Send to Screen Left"
local_right_id="${IDS[1]}"

kdotool windowactivate "$top_left_id" >/dev/null
sleep 0.35
launch BOTTOM_LEFT
invoke "PZH Send to Screen Left"
bottom_left_id="${IDS[2]}"

launch OTHER_SCREEN
invoke "PZH Send to Screen Right"
other_screen_id="${IDS[3]}"

top_left_geometry="$(geometry "$top_left_id")"
local_right_geometry="$(geometry "$local_right_id")"
bottom_left_geometry="$(geometry "$bottom_left_id")"
other_screen_geometry="$(geometry "$other_screen_id")"
bottom_left_x="${bottom_left_geometry%% *}"
local_right_x="${local_right_geometry%% *}"
other_screen_x="${other_screen_geometry%% *}"
(( local_right_x > bottom_left_x && other_screen_x > local_right_x )) || {
    echo "Could not construct the interior-pane cross-screen fixture." >&2
    exit 1
}

# Regression from the user screencast: bottom-left must first select the
# full-height right pane on the SAME output, never the next monitor.
kdotool windowactivate "$bottom_left_id" >/dev/null
sleep 0.35
invoke "PZH Focus Right"
[[ "$(active_window)" == "$local_right_id" ]] || {
    echo "Bottom-left focus skipped the same-output right pane." >&2
    exit 1
}

# Only the edge pane may cross the output boundary.
invoke "PZH Focus Right"
[[ "$(active_window)" == "$other_screen_id" ]] || {
    echo "Focus did not cross from the rightmost pane to the next output." >&2
    exit 1
}
invoke "PZH Focus Left"
[[ "$(active_window)" == "$local_right_id" ]] || {
    echo "Focus did not cross from the right output to the left." >&2
    exit 1
}

[[ "$(geometry "$top_left_id")" == "$top_left_geometry" ]]
[[ "$(geometry "$local_right_id")" == "$local_right_geometry" ]]
[[ "$(geometry "$bottom_left_id")" == "$bottom_left_geometry" ]]
[[ "$(geometry "$other_screen_id")" == "$other_screen_geometry" ]]
"$ROOT/tests/live-coverage.sh" 3

printf 'Live focus preferred the local pane, then crossed at the edge, without moving windows.\n'
