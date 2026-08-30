#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly TITLE="PZH-SCREEN-TRANSFER"
window_id=""
konsole_pid=""

cleanup() {
    if [[ -n "$window_id" ]]; then
        kdotool windowclose "$window_id" >/dev/null 2>&1 || true
    fi
    if [[ -n "$konsole_pid" ]]; then
        kill "$konsole_pid" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

for command_name in kdotool konsole qdbus6 awk; do
    command -v "$command_name" >/dev/null
done

grep -q 'Omarchy' < <("$ROOT/bin/plasmazones-mode-toggle" status) || {
    echo "Live screen-transfer testing requires Omarchy mode." >&2
    exit 2
}

invoke() {
    qdbus6 org.kde.kglobalaccel /component/kwin \
        org.kde.kglobalaccel.Component.invokeShortcut "$1" >/dev/null
}

window_x() {
    kdotool getwindowgeometry "$window_id" | awk '
        /Position:/ {gsub(/,/, " ", $2); print int($2)}'
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
[[ -n "$window_id" ]] || {
    echo "Timed out waiting for the disposable Konsole window." >&2
    exit 1
}
kdotool windowactivate "$window_id" >/dev/null
sleep 0.35

# Normalize onto the leftmost output, transfer right, then return left.
invoke "PZH Direct Screen Left"
sleep 0.45
left_x="$(window_x)"
invoke "PZH Direct Screen Right"
sleep 0.45
right_x="$(window_x)"
(( right_x > left_x )) || {
    echo "Window did not move to the right output: ${left_x} -> ${right_x}" >&2
    exit 1
}
"$ROOT/tests/live-coverage.sh" 3

invoke "PZH Direct Screen Left"
sleep 0.45
returned_x="$(window_x)"
(( returned_x < right_x )) || {
    echo "Window did not return to the left output: ${right_x} -> ${returned_x}" >&2
    exit 1
}
"$ROOT/tests/live-coverage.sh" 3

printf 'Live screen transfer passed: x=%s -> %s -> %s.\n' \
    "$left_x" "$right_x" "$returned_x"
