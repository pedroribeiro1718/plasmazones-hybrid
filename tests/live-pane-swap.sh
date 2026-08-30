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
    sleep 0.4
}

geometry() {
    kdotool getwindowgeometry "$1" | awk '
        /Position:/ {gsub(/,/, " ", $2); x=$2; y=$3}
        /Geometry:/ {print x, y, $2}'
}

launch() {
    local index="$1" title id=""
    title="PZH-PANE-SWAP-${index}"
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
    echo "Live pane-swap testing requires Omarchy mode." >&2
    exit 2
}
kdotool set_desktop "$TEST_DESKTOP" >/dev/null
sleep 0.35
for index in 0 1 2 3; do
    launch "$index"
done

geometry_0="$(geometry "${IDS[0]}")"
geometry_1="$(geometry "${IDS[1]}")"
geometry_2="$(geometry "${IDS[2]}")"
geometry_3="$(geometry "${IDS[3]}")"
readonly geometry_0 geometry_1 geometry_2 geometry_3

assert_geometry_set() {
    local expected id actual count
    for expected in "$geometry_0" "$geometry_1" "$geometry_2" "$geometry_3"; do
        count=0
        for id in "${IDS[@]}"; do
            actual="$(geometry "$id")"
            if [[ "$actual" == "$expected" ]]; then
                ((count += 1))
            fi
        done
        (( count == 1 ))
    done
}

# The newest window starts bottom-right. Swap vertically with the large upper
# pane, then return. Every other pane must remain exactly where it was.
invoke "PZH Move Up"
[[ "$(geometry "${IDS[3]}")" == "$geometry_1" ]]
[[ "$(geometry "${IDS[1]}")" == "$geometry_3" ]]
[[ "$(geometry "${IDS[0]}")" == "$geometry_0" ]]
[[ "$(geometry "${IDS[2]}")" == "$geometry_2" ]]
invoke "PZH Move Down"
assert_geometry_set
down_geometry="$(geometry "${IDS[3]}")"
[[ "$down_geometry" == "$geometry_2" ||
   "$down_geometry" == "$geometry_3" ]]

# Repeat across the X axis from whichever lower pane won the valid Y-axis
# tie. The focused window must cross to the other lower pane and back while
# the complete pane-geometry set remains unchanged.
if [[ "$down_geometry" == "$geometry_2" ]]; then
    invoke "PZH Move Right"
    [[ "$(geometry "${IDS[3]}")" == "$geometry_3" ]]
    assert_geometry_set
    invoke "PZH Move Left"
    [[ "$(geometry "${IDS[3]}")" == "$geometry_2" ]]
else
    invoke "PZH Move Left"
    [[ "$(geometry "${IDS[3]}")" == "$geometry_2" ]]
    assert_geometry_set
    invoke "PZH Move Right"
    [[ "$(geometry "${IDS[3]}")" == "$geometry_3" ]]
fi
assert_geometry_set

"$ROOT/tests/live-coverage.sh" 3
printf 'Live pane swaps passed on both X and Y axes without structural geometry changes.\n'
