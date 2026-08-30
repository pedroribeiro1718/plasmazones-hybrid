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

launch LEFT
invoke "PZH Send to Screen Left"
left_id="${IDS[0]}"
launch RIGHT
invoke "PZH Send to Screen Right"
right_id="${IDS[1]}"

left_geometry="$(geometry "$left_id")"
right_geometry="$(geometry "$right_id")"
left_x="${left_geometry%% *}"
right_x="${right_geometry%% *}"
(( right_x > left_x )) || {
    echo "Could not place test windows on separate outputs." >&2
    exit 1
}

kdotool windowactivate "$left_id" >/dev/null
sleep 0.35
invoke "PZH Focus Right"
[[ "$(active_window)" == "$right_id" ]] || {
    echo "Focus did not cross from the left output to the right." >&2
    exit 1
}
invoke "PZH Focus Left"
[[ "$(active_window)" == "$left_id" ]] || {
    echo "Focus did not cross from the right output to the left." >&2
    exit 1
}

[[ "$(geometry "$left_id")" == "$left_geometry" ]]
[[ "$(geometry "$right_id")" == "$right_geometry" ]]
"$ROOT/tests/live-coverage.sh" 3

printf 'Live focus crossed both outputs without moving either window.\n'
