#!/usr/bin/env bash

set -euo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PZ_SERVICE="org.plasmazones"
readonly PZ_OBJECT="/PlasmaZones"
readonly LAYOUT_IFACE="org.plasmazones.LayoutRegistry"
readonly SETTINGS_IFACE="org.plasmazones.Settings"
readonly RULES_IFACE="org.plasmazones.Rules"
readonly SCREEN_IFACE="org.plasmazones.Screen"
readonly GUARD_ID="plasmazones-omarchy-lock"
readonly LAYOUT_NAME="PlasmaZones Hybrid Grid (3x2)"
readonly STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/plasmazones-hybrid"
readonly STATE_FILE="${STATE_ROOT}/install-state.json"
readonly BIN_DIR="${HOME}/.local/bin"
readonly APP_DIR="${HOME}/.local/share/applications"
readonly KWIN_SCRIPT_DIR="${HOME}/.local/share/kwin/scripts/${GUARD_ID}"

fail() {
    printf 'Installation failed: %s\n' "$1" >&2
    exit 1
}

for command_name in qdbus6 jq flock install sed kwriteconfig6 kreadconfig6 kbuildsycoca6; do
    command -v "$command_name" >/dev/null || fail "$command_name is required."
done

qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 \
    || fail "PlasmaZones is not running. Install and enable it first."

if [[ -f "$STATE_FILE" ]]; then
    printf 'PlasmaZones Hybrid is already installed. Nothing changed.\n'
    printf 'Run ./uninstall.sh before reinstalling so the original rollback state is preserved.\n'
    exit 0
fi

exec 9>"/tmp/plasmazones-hybrid-install-${UID}.lock"
flock -n 9 || fail "Another installation or removal is running."

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${STATE_ROOT}/backups/${timestamp}"
mkdir -p "$backup_dir/home"

backup_path() {
    local source_path="$1"
    local relative_path destination_path

    if [[ ! -e "$source_path" && ! -L "$source_path" ]]; then
        return
    fi
    relative_path="${source_path#"${HOME}/"}"
    destination_path="${backup_dir}/home/${relative_path}"
    mkdir -p "$(dirname -- "$destination_path")"
    cp -a -- "$source_path" "$destination_path"
}

backup_path "${HOME}/.config/plasmazones"
backup_path "${HOME}/.config/kglobalshortcutsrc"
backup_path "${HOME}/.config/kwinrc"
backup_path "${BIN_DIR}/plasmazones-mode-toggle"
backup_path "${APP_DIR}/plasmazones-mode-toggle.desktop"
backup_path "$KWIN_SCRIPT_DIR"

states_before="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.getScreenStates")"
rules_before="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$RULES_IFACE.getAllRules")"
settings_before="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$SETTINGS_IFACE.getAllSettings")"
guard_enabled_before="$(kreadconfig6 --file kwinrc --group Plugins --key "${GUARD_ID}Enabled" --default false)"

jq -e 'type == "array" and length > 0' >/dev/null <<<"$states_before" \
    || fail "PlasmaZones reported no active monitor contexts."
jq -e 'type == "object" and (.rules | type == "array")' >/dev/null <<<"$rules_before" \
    || fail "Could not capture PlasmaZones rules."

mkdir -p "$STATE_ROOT"
provisional_state="$(mktemp --tmpdir="$STATE_ROOT" install-state.XXXXXX)"
jq -n \
    --arg installedAt "$timestamp" \
    --arg backupDir "$backup_dir" \
    --arg guardEnabledBefore "$guard_enabled_before" \
    --argjson statesBefore "$states_before" \
    --argjson rulesBefore "$rules_before" \
    --argjson settingsBefore "$settings_before" \
    '{
        version: 1,
        installedAt: $installedAt,
        backupDir: $backupDir,
        guardEnabledBefore: ($guardEnabledBefore == "true"),
        statesBefore: $statesBefore,
        rulesBefore: $rulesBefore,
        settingsBefore: $settingsBefore,
        layoutId: null,
        layoutCreated: false
    }' >"$provisional_state"
install -m 0600 "$provisional_state" "$STATE_FILE"
rm -f "$provisional_state"

install -Dm755 "$ROOT/bin/plasmazones-mode-toggle" \
    "$BIN_DIR/plasmazones-mode-toggle"
install -Dm644 "$ROOT/kwin/${GUARD_ID}/metadata.json" \
    "$KWIN_SCRIPT_DIR/metadata.json"
install -Dm644 "$ROOT/kwin/${GUARD_ID}/contents/code/main.js" \
    "$KWIN_SCRIPT_DIR/contents/code/main.js"

desktop_tmp="$(mktemp)"
sed "s|@EXEC@|${BIN_DIR}/plasmazones-mode-toggle|g" \
    "$ROOT/share/applications/plasmazones-mode-toggle.desktop.in" >"$desktop_tmp"
install -Dm644 "$desktop_tmp" "$APP_DIR/plasmazones-mode-toggle.desktop"
rm -f "$desktop_tmp"

find_layout_id() {
    local layout_id layout_json
    while IFS= read -r layout_id; do
        [[ -n "$layout_id" ]] || continue
        layout_json="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" \
            "$LAYOUT_IFACE.getLayout" "$layout_id" 2>/dev/null || true)"
        if jq -e --arg name "$LAYOUT_NAME" '.name == $name' >/dev/null 2>&1 <<<"$layout_json"; then
            printf '%s\n' "$layout_id"
            return 0
        fi
    done < <(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.getLayoutList")
    return 1
}

layout_created=false
layout_id="$(find_layout_id || true)"
if [[ -z "$layout_id" ]]; then
    layout_id="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" \
        "$LAYOUT_IFACE.importLayout" "$ROOT/layouts/hybrid-grid-3x2.json")"
    [[ -n "$layout_id" ]] || fail "Could not import the bundled 3x2 layout."
    layout_created=true
fi

state_tmp="$(mktemp --tmpdir="$STATE_ROOT" install-state.XXXXXX)"
jq --arg layoutId "$layout_id" --argjson layoutCreated "$layout_created" \
    '.layoutId = $layoutId | .layoutCreated = $layoutCreated' \
    "$STATE_FILE" >"$state_tmp"
install -m 0600 "$state_tmp" "$STATE_FILE"
rm -f "$state_tmp"

set_setting() {
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" \
        "$SETTINGS_IFACE.setSetting" "$1" "$2" >/dev/null \
        || fail "Could not set PlasmaZones option $1."
}

set_setting snappingEnabled true
set_setting autotileEnabled true
set_setting snappingFocusFollowsMouse false
set_setting autotileFocusFollowsMouse false
set_setting snappingFocusNewWindows false
set_setting autotileFocusNewWindows true
set_setting innerGap 8
set_setting outerGap 12
set_setting usePerSideOuterGap false
set_setting autotileDragBehavior 1
set_setting autotileInsertPosition 1
set_setting autotileKeepFloatingAbove true
set_setting autotileMasterCount 1
set_setting autotileMaxWindows 6
set_setting autotileOverflowBehavior 0
set_setting autotileRespectMinimumSize true
set_setting autotileSmartGaps false
set_setting autotileSplitRatio 0.5
set_setting defaultAutotileAlgorithm master-stack
set_setting animationSequenceMode 0
set_setting animationStaggerInterval 10
set_setting showWindowBorder true
set_setting hideWindowTitleBars true
set_setting windowBorderColorActive '#ff89b4fa'
set_setting windowBorderColorInactive '#cc5c6370'
set_setting windowBorderRadius 10
set_setting windowBorderScope all
set_setting windowBorderWidth 2
set_setting windowTitleBarScope tiled
set_setting focusFadeDuration 180
set_setting focusZoneDownShortcut 'Meta+Down'
set_setting focusZoneLeftShortcut 'Meta+Left'
set_setting focusZoneRightShortcut 'Meta+Right'
set_setting focusZoneUpShortcut 'Meta+Up'
set_setting swapWindowDownShortcut 'Meta+Shift+Down'
set_setting swapWindowLeftShortcut 'Meta+Shift+Left'
set_setting swapWindowRightShortcut 'Meta+Shift+Right'
set_setting swapWindowUpShortcut 'Meta+Shift+Up'
set_setting layoutPickerShortcut 'Meta+G'
set_setting openEditorShortcut 'Meta+Shift+G'
set_setting toggleWindowFloatShortcut 'Meta+T'
set_setting autotileDecMasterRatioShortcut 'Meta+-'
set_setting autotileIncMasterRatioShortcut 'Meta+='
set_setting autotileRetileShortcut 'Meta+Ctrl+T'
# The repository launcher owns Meta+Shift+T; release PlasmaZones' native
# per-screen mode cycle so one key press cannot run both implementations.
set_setting autotileToggleShortcut ''

upsert_rule() {
    local rule_file="$1"
    local rule_json rule_id all_rules
    rule_json="$(jq -c . "$rule_file")"
    rule_id="$(jq -r .id <<<"$rule_json")"
    all_rules="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$RULES_IFACE.getAllRules")"
    if jq -e --arg id "$rule_id" 'any(.rules[]; .id == $id)' >/dev/null <<<"$all_rules"; then
        qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$RULES_IFACE.updateRule" "$rule_json" >/dev/null
    else
        qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$RULES_IFACE.addRule" "$rule_json" >/dev/null
    fi
}

upsert_rule "$ROOT/rules/stable-geometry.json"
upsert_rule "$ROOT/rules/float-steam.json"

qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.setSaveBatchMode" true >/dev/null
while IFS= read -r state; do
    screen_id="$(jq -r '.screenId' <<<"$state")"
    desktop="$(jq -r '.virtualDesktop' <<<"$state")"
    activity="$(jq -r '.activity // ""' <<<"$state")"
    screen_info="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$SCREEN_IFACE.getScreenInfo" "$screen_id")"
    logical_width="$(jq -r '.geometry.width' <<<"$screen_info")"
    if (( logical_width >= 2200 )); then
        algorithm="bsp"
    else
        algorithm="master-stack"
    fi
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.setAssignmentEntry" \
        "$screen_id" "$desktop" "$activity" 1 "$layout_id" "$algorithm" >/dev/null
    printf 'Configured %s (%s logical px): %s\n' "$screen_id" "$logical_width" "$algorithm"
done < <(jq -c '.[]' <<<"$states_before")
qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$LAYOUT_IFACE.applyAssignmentChanges" >/dev/null

kwriteconfig6 --file kwinrc --group Plugins --key "${GUARD_ID}Enabled" true
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$GUARD_ID" >/dev/null 2>&1 || true
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript \
    "$KWIN_SCRIPT_DIR/contents/code/main.js" "$GUARD_ID" >/dev/null
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
kbuildsycoca6 --noincremental >/dev/null

"$BIN_DIR/plasmazones-mode-toggle" omarchy

printf '\nPlasmaZones Hybrid installed without sudo.\n'
printf 'Toggle modes with Super+Shift+T or run: plasmazones-mode-toggle [omarchy|fancyzones|reflow|status]\n'
printf 'Backup: %s\n' "$backup_dir"
