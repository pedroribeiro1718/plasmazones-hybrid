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

for command_name in kdotool konsole awk; do
    command -v "$command_name" >/dev/null
done

status="$("$ROOT/bin/plasmazones-mode-toggle" status)"
grep -q 'Omarchy' <<<"$status" || {
    echo "Live stable-removal testing requires Omarchy mode." >&2
    exit 2
}

wait_for_id() {
    local title="$1"
    local id=""
    for _ in {1..50}; do
        id="$(kdotool search --name "^${title}.*Konsole$" \
            getwindowid %1 2>/dev/null || true)"
        if [[ -n "$id" ]]; then
            printf '%s\n' "$id"
            return 0
        fi
        sleep 0.1
    done
    echo "Timed out waiting for $title" >&2
    return 1
}

geometry() {
    kdotool getwindowgeometry "$1" | awk '
        /Position:/ {gsub(/,/, " ", $2); x=$2; y=$3}
        /Geometry:/ {split($2, size, "x"); print x, y, size[1], size[2]}'
}

near() {
    local actual="$1" expected="$2"
    (( actual >= expected - 2 && actual <= expected + 2 ))
}

launch_test_window() {
    local title="$1" id
    konsole --separate -p "LocalTabTitleFormat=${title}" \
        -p "tabtitle=${title}" --hold \
        -e /usr/bin/sleep 120 &
    PIDS+=("$!")
    id="$(wait_for_id "$title")"
    IDS+=("$id")
    kdotool windowactivate "$id" >/dev/null
    sleep 0.35
}

kdotool set_desktop "$TEST_DESKTOP" >/dev/null
sleep 0.35

# Focus-driven insertion creates:
#   0 | 1
#     |---
#     |2|3
for index in 0 1 2 3; do
    launch_test_window "PZH-STABLE-${index}"
done

read -r target_x target_y target_width target_height \
    <<<"$(geometry "${IDS[1]}")"
read -r _older_x older_y _older_width older_height \
    <<<"$(geometry "${IDS[2]}")"
read -r _newer_x newer_y _newer_width newer_height \
    <<<"$(geometry "${IDS[3]}")"

near "$older_y" "$newer_y"
near "$older_height" "$newer_height"

kdotool windowminimize "${IDS[1]}" >/dev/null
sleep 0.45

read -r promoted_x promoted_y promoted_width promoted_height \
    <<<"$(geometry "${IDS[2]}")"
read -r remaining_x remaining_y remaining_width remaining_height \
    <<<"$(geometry "${IDS[3]}")"

near "$promoted_x" "$target_x"
near "$promoted_y" "$target_y"
near "$promoted_width" "$target_width"
near "$promoted_height" "$target_height"
near "$remaining_x" "$target_x"
near "$remaining_y" "$older_y"
near "$remaining_width" "$target_width"
near "$remaining_height" "$older_height"

"$ROOT/tests/live-coverage.sh" 3

# Restore the minimized test client before cleanup so the controller's
# re-adoption path is exercised too.
kdotool windowstate --remove MINIMIZED "${IDS[1]}" >/dev/null
sleep 0.35
"$ROOT/tests/live-coverage.sh" 2

# Reset the isolated desktop and repeat with a real close event. This exercises
# window.closed independently from the minimizedChanged eligibility path.
for id in "${IDS[@]}"; do
    kdotool windowclose "$id" >/dev/null 2>&1 || true
done
for pid in "${PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
done
IDS=()
PIDS=()
sleep 0.45

for index in 0 1 2 3; do
    launch_test_window "PZH-CLOSE-${index}"
done

read -r target_x target_y target_width target_height \
    <<<"$(geometry "${IDS[1]}")"
read -r _older_x older_y _older_width older_height \
    <<<"$(geometry "${IDS[2]}")"
kdotool windowclose "${IDS[1]}" >/dev/null
sleep 0.45

read -r promoted_x promoted_y promoted_width promoted_height \
    <<<"$(geometry "${IDS[2]}")"
read -r remaining_x remaining_y remaining_width remaining_height \
    <<<"$(geometry "${IDS[3]}")"

near "$promoted_x" "$target_x"
near "$promoted_y" "$target_y"
near "$promoted_width" "$target_width"
near "$promoted_height" "$target_height"
near "$remaining_x" "$target_x"
near "$remaining_y" "$older_y"
near "$remaining_width" "$target_width"
near "$remaining_height" "$older_height"
"$ROOT/tests/live-coverage.sh" 3

printf 'Live stable removal passed for both minimize and close promotion paths.\n'
