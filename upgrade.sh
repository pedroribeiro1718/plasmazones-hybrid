#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT
readonly PZ_SERVICE="org.plasmazones"
readonly PZ_OBJECT="/PlasmaZones"
readonly SETTINGS_IFACE="org.plasmazones.Settings"
readonly RULES_IFACE="org.plasmazones.Rules"
readonly GUARD_ID="plasmazones-omarchy-lock"
readonly STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/plasmazones-hybrid"
readonly STATE_FILE="${STATE_ROOT}/install-state.json"
readonly BIN_DIR="${HOME}/.local/bin"
readonly APP_DIR="${HOME}/.local/share/applications"
readonly KWIN_SCRIPT_DIR="${HOME}/.local/share/kwin/scripts/${GUARD_ID}"

fail() {
    printf 'Upgrade failed: %s\n' "$1" >&2
    exit 1
}

for command_name in qdbus6 jq flock install sed awk kwriteconfig6 kbuildsycoca6; do
    command -v "$command_name" >/dev/null || fail "$command_name is required."
done

[[ -f "$STATE_FILE" ]] || fail "No existing installation was found; run ./install.sh instead."
qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1 \
    || fail "PlasmaZones is not running."

exec 9>"/tmp/plasmazones-hybrid-install-${UID}.lock"
flock -n 9 || fail "Another installation or removal is running."

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

set_setting() {
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" \
        "$SETTINGS_IFACE.setSetting" "$1" "$2" >/dev/null \
        || fail "Could not set PlasmaZones option $1."
}

set_setting autotileDecMasterRatioShortcut ''
set_setting autotileIncMasterRatioShortcut ''
set_setting autotileDecMasterCountShortcut ''
set_setting autotileIncMasterCountShortcut ''
set_setting scrollingMaximizeColumnShortcut ''
set_setting animationSequenceMode 0
set_setting animationStaggerInterval 10
set_setting animationDuration 120
set_setting focusFadeDuration 100
set_setting defaultAutotileAlgorithm dwindle-memory
set_setting swapWindowLeftShortcut ''
set_setting swapWindowRightShortcut ''
set_setting swapWindowUpShortcut ''
set_setting swapWindowDownShortcut ''
set_setting focusZoneDownShortcut ''
set_setting focusZoneLeftShortcut ''
set_setting focusZoneRightShortcut ''
set_setting focusZoneUpShortcut ''
set_setting toggleWindowFloatShortcut ''

# Early development builds installed monitor-specific BSP/Master+Stack rules.
# Assignments now own the engine choice, so keeping these context rules adds a
# second source of truth even when their action happens to be migrated.
all_rules="$(qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" "$RULES_IFACE.getAllRules")"
while IFS= read -r obsolete_rule_id; do
    [[ -n "$obsolete_rule_id" ]] || continue
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" \
        "$RULES_IFACE.removeRule" "$obsolete_rule_id" >/dev/null \
        || fail "Could not remove obsolete monitor engine rule."
done < <(jq -r '.rules[] |
    select(.name == "Omarchy BSP on Dell" or
           .name == "Omarchy Master + Stack on AORUS") | .id' \
    <<<"$all_rules")

# Same-screen RouteToScreen rules from earlier builds are unsafe for existing
# windows: PlasmaZones may resolve a transfer against stale source identity and
# route it backwards, repeatedly removing/reopening and retiling the client.
while IFS= read -r obsolete_rule_id; do
    [[ -n "$obsolete_rule_id" ]] || continue
    qdbus6 "$PZ_SERVICE" "$PZ_OBJECT" \
        "$RULES_IFACE.removeRule" "$obsolete_rule_id" >/dev/null \
        || fail "Could not remove obsolete active-output routing rule."
done < <(jq -r '.rules[] |
    select(.priority == 50 and
           (.name | startswith("Keep new windows on ")) and
           .match.field == "screenId" and
           .match.op == "equals" and
           (.actions | length) == 1 and
           .actions[0].type == "routeToScreen" and
           .actions[0].targetScreenId == .match.value) | .id' \
    <<<"$all_rules")

while IFS= read -r stale_action; do
    [[ -n "$stale_action" ]] || continue
    qdbus6 org.kde.kglobalaccel /kglobalaccel \
        org.kde.KGlobalAccel.unregister kwin "$stale_action" >/dev/null 2>&1 || true
    kwriteconfig6 --file kglobalshortcutsrc --group kwin \
        --key "$stale_action" --delete
done < <(awk -F= '/^(KZones|Krohnkite|Polonium)/ {print $1}' \
    "${HOME}/.config/kglobalshortcutsrc")

qdbus6 org.kde.kglobalaccel /kglobalaccel \
    org.kde.KGlobalAccel.unregister kwin view_zoom_in >/dev/null 2>&1 || true
kwriteconfig6 --file kglobalshortcutsrc --group kwin --key view_zoom_in \
    $'none,Meta++\tMeta+=,Zoom In'

for workspace_number in 1 2 3 4; do
    task_action="activate task manager entry ${workspace_number}"
    qdbus6 org.kde.kglobalaccel /kglobalaccel \
        org.kde.KGlobalAccel.unregister plasmashell "$task_action" >/dev/null 2>&1 || true
    kwriteconfig6 --file kglobalshortcutsrc --group plasmashell \
        --key "$task_action" \
        "none,Meta+${workspace_number},Activate Task Manager Entry ${workspace_number}"
done

for direction in Left Right Up Down; do
    desktop_action="Window One Desktop ${direction}"
    if [[ "$direction" == "Left" || "$direction" == "Right" ]]; then
        desktop_action="Window One Desktop to the ${direction}"
    fi
    qdbus6 org.kde.kglobalaccel /kglobalaccel \
        org.kde.KGlobalAccel.unregister kwin "$desktop_action" \
        >/dev/null 2>&1 || true
    kwriteconfig6 --file kglobalshortcutsrc --group kwin \
        --key "$desktop_action" --delete
done

kwriteconfig6 --file kwinrc --group Plugins --key "${GUARD_ID}Enabled" true
qdbus6 org.kde.KWin /Scripting \
    org.kde.kwin.Scripting.unloadScript "$GUARD_ID" >/dev/null 2>&1 || true
for direction in Left Right Up Down; do
    legacy_action="PZH Send to Screen ${direction}"
    qdbus6 org.kde.kglobalaccel /kglobalaccel \
        org.kde.KGlobalAccel.unregister kwin "$legacy_action" \
        >/dev/null 2>&1 || true
    kwriteconfig6 --file kglobalshortcutsrc --group kwin \
        --key "$legacy_action" --delete
done
qdbus6 org.kde.KWin /Scripting \
    org.kde.kwin.Scripting.loadScript "$KWIN_SCRIPT_DIR/contents/code/main.js" \
    "$GUARD_ID" >/dev/null || fail "Could not load the KWin controller."
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null \
    || fail "Could not start the KWin controller."

kbuildsycoca6 --noincremental >/dev/null
"$BIN_DIR/plasmazones-mode-toggle" omarchy

printf 'PlasmaZones Hybrid upgraded in place; the original uninstall snapshot is intact.\n'
