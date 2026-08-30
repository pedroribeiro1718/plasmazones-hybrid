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
    sleep 0.55
}

geometry() {
    kdotool getwindowgeometry "$1" | awk '
        /Position:/ {gsub(/,/, " ", $2); x=$2; y=$3}
        /Geometry:/ {print x, y, $2}'
}

launch() {
    local label="$1" title id=""
    title="PZH-UNIFIED-MOVE-${label}"
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
    echo "Live unified-movement testing requires Omarchy mode." >&2
    exit 2
}

kdotool set_desktop "$TEST_DESKTOP" >/dev/null
sleep 0.35

launch TOP_LEFT
invoke "PZH Direct Screen Left"
top_left_id="${IDS[0]}"
launch LOCAL_RIGHT
invoke "PZH Direct Screen Left"
local_right_id="${IDS[1]}"
kdotool windowactivate "$top_left_id" >/dev/null
sleep 0.35
launch BOTTOM_LEFT
invoke "PZH Direct Screen Left"
bottom_left_id="${IDS[2]}"
launch OTHER_SCREEN
invoke "PZH Direct Screen Right"
other_screen_id="${IDS[3]}"

bottom_left_geometry="$(geometry "$bottom_left_id")"
local_right_geometry="$(geometry "$local_right_id")"
other_screen_geometry="$(geometry "$other_screen_id")"
local_right_x="${local_right_geometry%% *}"
other_screen_x="${other_screen_geometry%% *}"
(( other_screen_x > local_right_x ))

# One chord swaps with the immediate pane; it must not jump screens.
kdotool windowactivate "$bottom_left_id" >/dev/null
sleep 0.35
invoke "PZH Move Right"
[[ "$(geometry "$bottom_left_id")" == "$local_right_geometry" ]]
[[ "$(geometry "$local_right_id")" == "$bottom_left_geometry" ]]
[[ "$(geometry "$other_screen_id")" == "$other_screen_geometry" ]]

# Repeating the same chord from the new edge pane continues to monitor two.
invoke "PZH Move Right"
moved_geometry="$(geometry "$bottom_left_id")"
moved_x="${moved_geometry%% *}"
destination_neighbor_geometry="$(geometry "$other_screen_id")"
destination_neighbor_x="${destination_neighbor_geometry%% *}"
(( moved_x >= other_screen_x )) || {
    echo "Edge-pane movement did not continue onto the next output." >&2
    exit 1
}
(( moved_x < destination_neighbor_x )) || {
    echo "Left-to-right arrival did not enter on the destination's left edge." >&2
    exit 1
}

# From that left edge, the reverse move must enter monitor one at its right
# boundary rather than appearing to the left of the resident aligned pane.
invoke "PZH Move Left"
returned_geometry="$(geometry "$bottom_left_id")"
returned_x="${returned_geometry%% *}"
resident_left_geometry="$(geometry "$top_left_id")"
resident_left_x="${resident_left_geometry%% *}"
(( returned_x < other_screen_x && returned_x > resident_left_x )) || {
    echo "Right-to-left arrival did not enter on the destination's right edge." >&2
    exit 1
}

"$ROOT/tests/live-coverage.sh" 3
printf 'Unified movement entered both outputs at the boundary crossed.\n'
