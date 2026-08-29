#!/usr/bin/env bash

set -euo pipefail

readonly PZ_SERVICE="org.plasmazones"
readonly PZ_OBJECT="/PlasmaZones"
readonly LAYOUT_IFACE="org.plasmazones.LayoutRegistry"
readonly SETTINGS_IFACE="org.plasmazones.Settings"
readonly RULES_IFACE="org.plasmazones.Rules"
readonly GUARD_ID="plasmazones-omarchy-lock"
readonly STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/plasmazones-hybrid"
readonly STATE_FILE="${STATE_ROOT}/install-state.json"
readonly BIN_PATH="${HOME}/.local/bin/plasmazones-mode-toggle"
readonly DESKTOP_PATH="${HOME}/.local/share/applications/plasmazones-mode-toggle.desktop"
readonly KWIN_SCRIPT_DIR="${HOME}/.local/share/kwin/scripts/${GUARD_ID}"

readonly -a MANAGED_SETTINGS=(
    snappingEnabled autotileEnabled snappingFocusFollowsMouse
    autotileFocusFollowsMouse snappingFocusNewWindows autotileFocusNewWindows
    innerGap outerGap usePerSideOuterGap autotileDragBehavior
    autotileInsertPosition autotileKeepFloatingAbove autotileMasterCount
    autotileMaxWindows autotileOverflowBehavior autotileRespectMinimumSize
    autotileSmartGaps autotileSplitRatio defaultAutotileAlgorithm
    animationSequenceMode animationStaggerInterval showWindowBorder
    hideWindowTitleBars windowBorderColorActive windowBorderColorInactive
    windowBorderRadius windowBorderScope windowBorderWidth windowTitleBarScope
    focusFadeDuration focusZoneDownShortcut focusZoneLeftShortcut
    focusZoneRightShortcut focusZoneUpShortcut swapWindowDownShortcut
    swapWindowLeftShortcut swapWindowRightShortcut swapWindowUpShortcut
    layoutPickerShortcut openEditorShortcut toggleWindowFloatShortcut
    autotileDecMasterRatioShortcut autotileIncMasterRatioShortcut
    autotileRetileShortcut autotileToggleShortcut
)

[[ -f "$STATE_FILE" ]] || {
    printf 'No installation state found at %s\n' "$STATE_FILE" >&2
    exit 1
}

for command_name in qdbus6 jq flock install kwriteconfig6 kbuildsycoca6; do
    command -v "$command_name" >/dev/null || {
        printf '%s is required.\n' "$command_name" >&2
        exit 1
    }
done

qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 || {
    printf 'PlasmaZones must be running to restore its configuration.\n' >&2
    exit 1
}

exec 9>"/tmp/plasmazones-hybrid-install-${UID}.lock"
flock -n 9 || {
    printf 'Another installation or removal is running.\n' >&2
    exit 1
}

backup_dir="$(jq -r .backupDir "$STATE_FILE")"

qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$GUARD_ID" >/dev/null 2>&1 || true

rules_before="$(jq -c .rulesBefore "$STATE_FILE")"
qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$RULES_IFACE.setAllRules" "$rules_before" >/dev/null

for key in "${MANAGED_SETTINGS[@]}"; do
    value="$(jq -r --arg key "$key" \
        '.settingsBefore[$key] | if . == null then "__MISSING__" elif type == "string" then . else tostring end' \
        "$STATE_FILE")"
    [[ "$value" != "__MISSING__" ]] || continue
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$SETTINGS_IFACE.setSetting" "$key" "$value" >/dev/null
done

qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.setSaveBatchMode" true >/dev/null
while IFS= read -r state; do
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.setAssignmentEntry" \
        "$(jq -r '.screenId' <<<"$state")" \
        "$(jq -r '.virtualDesktop' <<<"$state")" \
        "$(jq -r '.activity // ""' <<<"$state")" \
        "$(jq -r '.mode' <<<"$state")" \
        "$(jq -r '.snappingLayoutId // ""' <<<"$state")" \
        "$(jq -r '.algorithmId // ""' <<<"$state")" >/dev/null || true
done < <(jq -c '.statesBefore[]' "$STATE_FILE")
qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.applyAssignmentChanges" >/dev/null

if [[ "$(jq -r .layoutCreated "$STATE_FILE")" == "true" ]]; then
    layout_id="$(jq -r .layoutId "$STATE_FILE")"
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.deleteLayout" "$layout_id" >/dev/null || true
fi

restore_path() {
    local target_path="$1"
    local relative_path backup_path
    relative_path="${target_path#"${HOME}/"}"
    backup_path="${backup_dir}/home/${relative_path}"

    if [[ -d "$target_path" && ! -L "$target_path" ]]; then
        rm -rf -- "$target_path"
    else
        rm -f -- "$target_path"
    fi
    if [[ -e "$backup_path" || -L "$backup_path" ]]; then
        mkdir -p "$(dirname -- "$target_path")"
        cp -a -- "$backup_path" "$target_path"
    fi
}

restore_path "$BIN_PATH"
restore_path "$DESKTOP_PATH"
restore_path "$KWIN_SCRIPT_DIR"

guard_enabled_before="$(jq -r .guardEnabledBefore "$STATE_FILE")"
kwriteconfig6 --file kwinrc --group Plugins --key "${GUARD_ID}Enabled" "$guard_enabled_before"
kbuildsycoca6 --noincremental >/dev/null

if [[ "$guard_enabled_before" == "true" && -f "$KWIN_SCRIPT_DIR/contents/code/main.js" ]]; then
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript \
        "$KWIN_SCRIPT_DIR/contents/code/main.js" "$GUARD_ID" >/dev/null
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
fi

archive_state="${STATE_ROOT}/uninstalled-$(date +%Y%m%d-%H%M%S).json"
mv -- "$STATE_FILE" "$archive_state"

printf 'PlasmaZones Hybrid removed and the captured configuration restored.\n'
printf 'Installation record: %s\n' "$archive_state"
