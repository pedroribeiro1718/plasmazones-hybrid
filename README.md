# PlasmaZones Hybrid

Two predictable window-management modes on KDE Plasma/Wayland:

- **Omarchy:** automatic keyboard-driven tiling, fixed tiled windows, and DPI-aware per-monitor algorithms.
- **FancyZones:** a six-zone grid with drag overlay and multi-zone spanning.

Switching modes also rearranges existing windows: FancyZones fills the active zones and Omarchy rebuilds each tiling tree.

## Install

Requirements: KDE Plasma 6 on Wayland, [PlasmaZones](https://phosphor-works.github.io/plasmazones/getting-started/) 3.4+, `jq`, and `qdbus6`.

```bash
git clone https://github.com/pedroribeiro1718/plasmazones-hybrid.git
cd plasmazones-hybrid
./install.sh
```

The installation is user-local and never uses `sudo`. It backs up affected files under `~/.local/state/plasmazones-hybrid/backups/`, installs the KWin guard and mode command, configures PlasmaZones, creates the 3×2 snapping layout, and activates Omarchy mode.

## Use

| Command/shortcut | Result |
| --- | --- |
| `Super+Shift+T` | Toggle modes and rearrange open windows |
| `plasmazones-mode-toggle omarchy` | Enter Omarchy and retile |
| `plasmazones-mode-toggle fancyzones` | Enter FancyZones and fill zones |
| `plasmazones-mode-toggle reflow` | Rearrange without changing mode |
| `plasmazones-mode-toggle status` | Show each monitor's active mode |
| `Super+Arrow` | Focus a window |
| `Super+Shift+Arrow` | Swap a window |
| `Super+T` | Toggle tiled/floating |
| `Super+G` | Open the layout picker |
| `Super+Shift+G` | Open the zone editor |

In FancyZones, `Alt`-drag shows the overlay and `Ctrl+Alt`-drag spans adjacent zones. Omarchy chooses BSP for logical widths of at least 2200 pixels and Master + Stack for smaller logical workspaces.

Steam is floated only in Omarchy mode. Games are unaffected.
New normal windows follow KWin's active-output placement. Per-monitor
self-routing rules prevent PlasmaZones' historical placement restore from
pulling them onto another output; higher-priority app rules still win.
Applications that cannot fit inside a single FancyZone, such as the Steam
client at its minimum size, remain unconstrained and can be spanned manually.

Re-running `./install.sh` is safe and makes no changes when an installation is
already recorded. To reinstall after pulling an update, run `./uninstall.sh`
and then `./install.sh`; the original rollback snapshot is preserved until
removal.

## Remove

```bash
./uninstall.sh
```

The uninstaller restores the captured PlasmaZones settings, rules, assignments, shortcut, and any files that existed before installation.

## Development

```bash
./tests/smoke.sh
```

MIT licensed.
