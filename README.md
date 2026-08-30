# PlasmaZones Hybrid

Two predictable window-management modes on KDE Plasma/Wayland:

- **Omarchy:** a focus-driven dwindle tree, keyboard-only structural moves/resizing, workspaces, and a scratchpad.
- **FancyZones:** a six-zone grid with drag overlay and multi-zone spanning.

Switching modes rearranges existing windows: FancyZones fills the active zones and Omarchy rebuilds a balanced tree on each output.

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
| `Super+Arrow` | Focus the adjacent pane; cross monitors only from an edge pane |
| `Super+Shift+Arrow` | Move through panes; continue onto the next monitor from an edge |
| `Super+T` | Toggle tiled/floating |
| `Super+-` / `Super+=` | Shrink/grow the focused tile's width |
| `Super+Shift+-` / `Super+Shift+=` | Shrink/grow its height |
| Add `Alt` / `Ctrl` | Use a fine/coarse resize step |
| `Super+F` | Toggle fullscreen |
| `Super+Alt+F` | Toggle full width |
| `Super+Q` | Close the focused window |
| `Super+1..4` | Switch workspace |
| `Super+Shift+1..4` | Move the focused window to a workspace |
| `Super+Shift+S` / `Super+S` | Send to / toggle the scratchpad |
| `Super+G` | Open the layout picker |
| `Super+Shift+G` | Open the zone editor |

In FancyZones, `Alt`-drag shows the overlay and `Ctrl+Alt`-drag spans adjacent zones. A mode switch uses the whole 3×2 grid: up to six windows partition all six cells; additional windows stack onto zones round-robin. A client whose minimum size exceeds one cell automatically spans adjacent cells. All geometry is calculated per output in logical coordinates, including mixed-DPI setups.

In Omarchy, the KWin controller owns a dwindle tree while PlasmaZones supplies mode/rule integration. A new window follows and splits the focused tile, including its monitor (wide tiles split left/right; tall tiles split top/bottom), falling back to the largest tile only when no managed window is focused. Directional movement swaps pane occupants without changing the tree. When a window closes, minimizes, hides, or leaves the output, the oldest leaf in its sibling subtree takes over the vacated tile. Utility, popup, and dialog windows never reserve a tile. Auto-hide docks overlay tiles without reducing usable desktop space.

Cross-monitor movement uses PlasmaZones' native output transaction, then re-adopts the window into the controller tree at the boundary crossed: left-to-right enters on the destination's left edge, right-to-left on its right edge, down on its top edge, and up on its bottom edge.

Steam is floated only in Omarchy mode. Games are unaffected.
New normal windows follow KWin's active-output placement. Per-monitor
self-routing rules prevent PlasmaZones' historical placement restore from
pulling them onto another output; higher-priority app rules still win.

After pulling an update, run `./install.sh` again. It upgrades in place while
preserving the original rollback snapshot used by `./uninstall.sh`.

## Remove

```bash
./uninstall.sh
```

The uninstaller restores the captured PlasmaZones settings, rules, assignments, shortcut, and any files that existed before installation.

## Development

```bash
./tests/smoke.sh
./tests/live-coverage.sh 5   # run inside a live Omarchy session
./tests/live-stable-removal.sh  # isolated close/minimize promotion test
./tests/live-screen-transfer.sh  # two horizontally arranged outputs
./tests/live-unified-movement.sh  # local pane swap, then edge crossing
./tests/live-cross-screen-focus.sh  # focus-only navigation across outputs
./tests/live-pane-swap.sh  # structure-preserving X/Y pane swaps
./tests/live-workspace-transfer.sh  # sends a window away and back
./tests/live-fancy-coverage.sh 5  # run inside a live FancyZones session
```

The live checks sample every output. Omarchy fails on uncovered cells,
overlap, or incomplete bounds; FancyZones fails on empty zones or windows
outside the grid. Run both around mode-transition tests.

MIT licensed.
