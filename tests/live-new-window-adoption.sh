#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly TEST_DESKTOP="${PZH_TEST_DESKTOP:-4}"
readonly RUN_ID="$$-$(date +%s%N)"
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

launch() {
    local label="$1" title id=""
    title="PZH-ADOPTION-${RUN_ID}-${label}"
    konsole --separate -p "LocalTabTitleFormat=${title}" \
        -p "tabtitle=${title}" --hold -e /usr/bin/sleep 120 &
    PIDS+=("$!")
    for _ in {1..50}; do
        id="$(kdotool search --name "^${title}.*Konsole$" \
            getwindowid %1 2>/dev/null || true)"
        [[ -z "$id" ]] || break
        sleep 0.05
    done
    [[ -n "$id" ]]
    IDS+=("$id")
}

window_x() {
    kdotool getwindowgeometry "$1" 2>/dev/null | awk '
        /Position:/ {gsub(/,/, "", $2); print int($2); exit}'
}

invoke() {
    qdbus6 org.kde.kglobalaccel /component/kwin \
        org.kde.kglobalaccel.Component.invokeShortcut "$1" >/dev/null
    sleep 0.6
}

grep -q 'Omarchy' < <("$ROOT/bin/plasmazones-mode-toggle" status) || {
    echo "Live new-window adoption testing requires Omarchy mode." >&2
    exit 2
}

kdotool set_desktop "$TEST_DESKTOP" >/dev/null
sleep 0.4

# Put a stable focused leaf on the right-hand output. New windows should be
# adopted next to this leaf even if KWin initially maps them on the other
# output; no click or explicit activation is allowed to finish the handoff.
launch ANCHOR
anchor_id="${IDS[0]}"
kdotool windowactivate "$anchor_id" >/dev/null
invoke "PZH Direct Screen Right"
anchor_x="$(window_x "$anchor_id")"
(( anchor_x > 0 ))

for label in SECOND THIRD FOURTH FIFTH SIXTH; do
    kdotool windowactivate "$anchor_id" >/dev/null
    sleep 0.2
    launch "$label"
    id="${IDS[-1]}"
    transitions=0
    previous_side=""
    for _ in {1..60}; do
        x="$(window_x "$id" || true)"
        if [[ -n "$x" ]]; then
            if (( x >= anchor_x )); then
                side="right"
            else
                side="left"
            fi
            if [[ -n "$previous_side" && "$side" != "$previous_side" ]]; then
                transitions=$((transitions + 1))
            fi
            previous_side="$side"
        fi
        sleep 0.05
    done
    [[ "$previous_side" == "right" ]] || {
        echo "$label did not settle on the focused output." >&2
        exit 1
    }
    (( transitions <= 1 )) || {
        echo "$label bounced between outputs $transitions times before settling." >&2
        exit 1
    }
done

"$ROOT/tests/live-coverage.sh" 6
printf 'New windows adopted the focused output without a focus-assisted loop.\n'
