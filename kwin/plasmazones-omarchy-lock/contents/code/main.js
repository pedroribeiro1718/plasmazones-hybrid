/*
 * PlasmaZones Hybrid controller
 *
 * PlasmaZones mode 0 (FancyZones): no intervention.
 * PlasmaZones mode 1 (Omarchy): cancel interactive mouse move/resize for
 * tiled windows while leaving explicitly floating windows alone. It also
 * exposes an Omarchy-style keyboard layer. Resize actions move one edge of
 * the focused leaf; dwindle-memory turns that edge delta into a branch-local
 * split-ratio update.
 */

const SERVICE = "org.plasmazones";
const OBJECT = "/PlasmaZones";
const SCREEN_INTERFACE = "org.plasmazones.Screen";
const LAYOUT_INTERFACE = "org.plasmazones.LayoutRegistry";
const TRACKING_INTERFACE = "org.plasmazones.WindowTracking";
const DRAG_INTERFACE = "org.plasmazones.WindowDrag";
const SNAP_INTERFACE = "org.plasmazones.Snap";
const TILING_INTERFACE = "org.plasmazones.Tiling";
const OMARCHY_MODE = 1;

// The bundled FancyZones layout is a fixed 3x2 grid. These UUIDs are stable
// because install/upgrade imports the repository layout verbatim.
const FANCY_ZONE_IDS = [
    "{59f32c55-7885-4ddd-8cb2-c1ea89cd0ddb}",
    "{847063ba-5236-4c33-93b0-e3b9f8cba4ab}",
    "{7b8c36a1-d342-43f3-a881-a2e2e45ff2c1}",
    "{e3d511fc-7d74-44e7-a875-3d790ec644bc}",
    "{0fac9b8a-903a-439f-bbaf-dcc5671cc36f}",
    "{09292138-0c49-4382-a791-5394c28f8b34}"
];
const FANCY_OUTER_GAP = 12;
const FANCY_INNER_GAP = 8;

const attachedWindows = new Map();
const gestures = new Map();
const screenIdsByConnector = new Map();
const modesByContext = new Map();
const floatingWindows = new Map();
const horizontallyMaximized = new Map();
const pendingTreeRestore = new Map();
const pendingScreenTransfers = new Map();
const controllerManaged = new Map();
const userFloated = new Map();
const treesByContext = new Map();
const closingWindows = new Map();
const openedOrder = new Map();
let nextGeneration = 1;
let nextOpenedOrder = 1;
let scratchpadWindow = null;
let applyingControllerGeometry = false;
let lastFocusedWindow = workspace.activeWindow;

const RESIZE_STEP = 0.05;
const RESIZE_STEP_FINE = 0.02;
const RESIZE_STEP_COARSE = 0.10;
const OUTPUT_EDGE_TOLERANCE = 32;

function log(message) {
    console.info("plasmazones-omarchy-lock: " + message);
}

function copyGeometry(rect) {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    };
}

function isUsableGeometry(rect) {
    return Boolean(rect && Number.isFinite(Number(rect.x)) &&
        Number.isFinite(Number(rect.y)) &&
        Number.isFinite(Number(rect.width)) &&
        Number.isFinite(Number(rect.height)) &&
        Number(rect.width) > 0 && Number(rect.height) > 0);
}

function appIdForWindow(window) {
    return String(window.desktopFileName || window.resourceClass ||
        window.resourceName || "").toLowerCase();
}

function isRuleFloated(window) {
    return appIdForWindow(window).indexOf("steam") >= 0;
}

function isTilingCandidate(window) {
    return Boolean(window && window.normalWindow && window.managed &&
        !window.minimized && !window.hidden && !window.deleted &&
        !window.skipTaskbar && !window.skipSwitcher &&
        !window.popupWindow && !window.dialog && !window.modal &&
        !window.transient);
}

function isOnCurrentDesktop(window) {
    if (window.onAllDesktops) {
        return true;
    }
    return window.desktops && window.desktops.some(function (desktop) {
        return desktop === workspace.currentDesktop;
    });
}

function fancyPartitions(windowCount) {
    const z = FANCY_ZONE_IDS;
    if (windowCount <= 1) {
        return [[z[0], z[1], z[2], z[3], z[4], z[5]]];
    }
    if (windowCount === 2) {
        // A 3-column grid cannot split into equal vertical halves. Prefer a
        // pragmatic browser-friendly 2/3 + 1/3 split over two short rows.
        return [[z[0], z[1], z[3], z[4]], [z[2], z[5]]];
    }
    if (windowCount === 3) {
        return [[z[0], z[3]], [z[1], z[4]], [z[2], z[5]]];
    }
    if (windowCount === 4) {
        return [[z[0], z[3]], [z[1], z[2]], [z[4]], [z[5]]];
    }
    if (windowCount === 5) {
        return [[z[0], z[3]], [z[1]], [z[2]], [z[4]], [z[5]]];
    }

    // Six cells are the hard budget. Extra windows intentionally stack in a
    // round-robin zone instead of creating geometry outside the grid.
    const partitions = [];
    for (let index = 0; index < windowCount; index++) {
        partitions.push([z[index % z.length]]);
    }
    return partitions;
}

function fancyZoneRect(output, zoneIndex) {
    const screen = output.geometry;
    const halfGap = FANCY_INNER_GAP / 2;
    const column = zoneIndex % 3;
    const row = Math.floor(zoneIndex / 3);
    const left = column === 0 ? screen.x + FANCY_OUTER_GAP :
        Math.round(screen.x + screen.width * column / 3 + halfGap);
    const right = column === 2 ?
        screen.x + screen.width - FANCY_OUTER_GAP :
        Math.round(screen.x + screen.width * (column + 1) / 3 - halfGap);
    const top = row === 0 ? screen.y + FANCY_OUTER_GAP :
        Math.round(screen.y + screen.height / 2 + halfGap);
    const bottom = row === 1 ?
        screen.y + screen.height - FANCY_OUTER_GAP :
        Math.round(screen.y + screen.height / 2 - halfGap);
    return {x: left, y: top, width: right - left, height: bottom - top};
}

function fancyPartitionRect(output, zoneIds) {
    const indexes = zoneIds.map(function (zoneId) {
        return FANCY_ZONE_IDS.indexOf(zoneId);
    });
    const rects = indexes.map(function (index) {
        return fancyZoneRect(output, index);
    });
    const left = Math.min.apply(null, rects.map(function (rect) {
        return rect.x;
    }));
    const top = Math.min.apply(null, rects.map(function (rect) {
        return rect.y;
    }));
    const right = Math.max.apply(null, rects.map(function (rect) {
        return rect.x + rect.width;
    }));
    const bottom = Math.max.apply(null, rects.map(function (rect) {
        return rect.y + rect.height;
    }));
    return {x: left, y: top, width: right - left, height: bottom - top};
}

function expandFancyPartitionForMinimum(output, zoneIds, window) {
    const indexes = zoneIds.map(function (zoneId) {
        return FANCY_ZONE_IDS.indexOf(zoneId);
    });
    const minSize = window.minSize || {width: 0, height: 0};
    let geometry = fancyPartitionRect(output, zoneIds);

    if (Number(minSize.height || 0) > geometry.height) {
        indexes.slice().forEach(function (index) {
            const counterpart = index < 3 ? index + 3 : index - 3;
            if (indexes.indexOf(counterpart) < 0) {
                indexes.push(counterpart);
            }
        });
    }

    geometry = fancyPartitionRect(output, indexes.map(function (index) {
        return FANCY_ZONE_IDS[index];
    }));
    while (Number(minSize.width || 0) > geometry.width) {
        const columns = indexes.map(function (index) { return index % 3; });
        const minColumn = Math.min.apply(null, columns);
        const maxColumn = Math.max.apply(null, columns);
        let targetColumn;
        if (maxColumn < 2) {
            targetColumn = maxColumn + 1;
        } else if (minColumn > 0) {
            targetColumn = minColumn - 1;
        } else {
            break;
        }
        const rows = Array.from(new Set(indexes.map(function (index) {
            return Math.floor(index / 3);
        })));
        rows.forEach(function (row) {
            const index = row * 3 + targetColumn;
            if (indexes.indexOf(index) < 0) {
                indexes.push(index);
            }
        });
        geometry = fancyPartitionRect(output, indexes.map(function (index) {
            return FANCY_ZONE_IDS[index];
        }));
    }

    return indexes.sort(function (a, b) { return a - b; }).map(
        function (index) { return FANCY_ZONE_IDS[index]; });
}

function applyFancyAdaptiveReflow(outputs) {
    const entries = [];

    outputs.forEach(function (output) {
        const screenId = screenIdsByConnector.get(String(output.name));
        if (screenId === undefined) {
            return;
        }
        const windows = workspace.windowList().filter(function (window) {
            return isTilingCandidate(window) && isOnCurrentDesktop(window) &&
                window.output === output && window !== scratchpadWindow;
        }).sort(function (a, b) {
            const aMin = a.minSize || {width: 0, height: 0};
            const bMin = b.minSize || {width: 0, height: 0};
            const minimumAreaDelta = Number(bMin.width || 0) *
                Number(bMin.height || 0) - Number(aMin.width || 0) *
                Number(aMin.height || 0);
            if (minimumAreaDelta !== 0) {
                return minimumAreaDelta;
            }
            const ar = a.frameGeometry;
            const br = b.frameGeometry;
            return ar.y - br.y || ar.x - br.x ||
                String(a.internalId).localeCompare(String(b.internalId));
        });
        const partitions = fancyPartitions(windows.length);
        windows.forEach(function (window, index) {
            const zoneIds = expandFancyPartitionForMinimum(output,
                partitions[index], window);
            const geometry = fancyPartitionRect(output, zoneIds);
            entries.push({
                windowId: plasmaZonesWindowId(window),
                sourceZoneId: "",
                targetZoneId: zoneIds[0],
                targetZoneIds: zoneIds,
                x: geometry.x,
                y: geometry.y,
                width: geometry.width,
                height: geometry.height,
                targetScreenId: String(screenId),
                virtualDesktop: desktopNumber(window)
            });
        });
    });

    if (entries.length === 0) {
        log("FancyZones adaptive reflow found no visible windows");
        return;
    }
    callDBus(SERVICE, OBJECT, SNAP_INTERFACE, "handleBatchedResnap",
        JSON.stringify(entries), function () {
            // Reassert the public snap contract after the compositor has
            // accepted the batch. Windows handed off by Omarchy were marked
            // floating so PlasmaZones' own autotiler could not race the local
            // tree; the explicit commits clear that handoff state and retain
            // every multi-zone span for later drag/navigation operations.
            entries.forEach(function (entry) {
                if (entry.targetZoneIds.length > 1) {
                    callDBus(SERVICE, OBJECT, SNAP_INTERFACE,
                        "windowSnappedMultiZone", entry.windowId,
                        entry.targetZoneIds, entry.targetScreenId,
                        function () {});
                } else {
                    callDBus(SERVICE, OBJECT, SNAP_INTERFACE,
                        "windowSnapped", entry.windowId,
                        entry.targetZoneId, entry.targetScreenId,
                        function () {});
                }
            });
            log("FancyZones adaptive reflow placed " + entries.length +
                " visible windows");
        });
}

function requestFancyAdaptiveReflow() {
    const outputs = Array.from(workspace.screenOrder);
    let pending = outputs.length;
    if (pending === 0) {
        return;
    }
    const identityResolved = function () {
        pending--;
        if (pending === 0) {
            applyFancyAdaptiveReflow(outputs);
        }
    };
    outputs.forEach(function (output) {
        const connector = String(output.name);
        if (screenIdsByConnector.has(connector)) {
            identityResolved();
            return;
        }
        callDBus(SERVICE, OBJECT, SCREEN_INTERFACE, "getScreenId", connector,
            function (screenId) {
                if (screenId) {
                    screenIdsByConnector.set(connector, String(screenId));
                }
                identityResolved();
            });
    });
}

function leaf(window) {
    return {window: window, first: null, second: null,
        orientation: "", ratio: 0.5};
}

function isLeaf(node) {
    return node && node.window !== null;
}

function buildTree(windows, rect) {
    if (windows.length === 0) {
        return null;
    }
    if (windows.length === 1) {
        return leaf(windows[0]);
    }
    const orientation = rect.width >= rect.height ? "v" : "h";
    const ordered = windows.slice().sort(function (a, b) {
        const aRect = a.frameGeometry;
        const bRect = b.frameGeometry;
        const aCenter = orientation === "v" ?
            aRect.x + aRect.width / 2 : aRect.y + aRect.height / 2;
        const bCenter = orientation === "v" ?
            bRect.x + bRect.width / 2 : bRect.y + bRect.height / 2;
        return aCenter - bCenter;
    });
    const midpoint = Math.ceil(ordered.length / 2);
    const gap = 8;
    let firstRect;
    let secondRect;
    if (orientation === "v") {
        const width = (rect.width - gap) / 2;
        firstRect = {x: rect.x, y: rect.y, width: width,
            height: rect.height};
        secondRect = {x: rect.x + width + gap, y: rect.y, width: width,
            height: rect.height};
    } else {
        const height = (rect.height - gap) / 2;
        firstRect = {x: rect.x, y: rect.y, width: rect.width,
            height: height};
        secondRect = {x: rect.x, y: rect.y + height + gap,
            width: rect.width, height: height};
    }
    return {window: null, orientation: orientation, ratio: 0.5,
        first: buildTree(ordered.slice(0, midpoint), firstRect),
        second: buildTree(ordered.slice(midpoint), secondRect)};
}

function collectTreeGeometries(node, rect, targets) {
    if (!node) {
        return;
    }
    if (isLeaf(node)) {
        if (node.window.fullScreen || horizontallyMaximized.has(node.window)) {
            return;
        }
        targets.push({window: node.window, geometry: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.max(80, Math.round(rect.width)),
            height: Math.max(80, Math.round(rect.height))
        }});
        return;
    }
    const gap = 8;
    if (node.orientation === "v") {
        const available = rect.width - gap;
        const firstWidth = Math.round(available * node.ratio);
        collectTreeGeometries(node.first, {x: rect.x, y: rect.y,
            width: firstWidth, height: rect.height}, targets);
        collectTreeGeometries(node.second, {x: rect.x + firstWidth + gap,
            y: rect.y, width: available - firstWidth, height: rect.height},
            targets);
    } else {
        const available = rect.height - gap;
        const firstHeight = Math.round(available * node.ratio);
        collectTreeGeometries(node.first, {x: rect.x, y: rect.y,
            width: rect.width, height: firstHeight}, targets);
        collectTreeGeometries(node.second, {x: rect.x,
            y: rect.y + firstHeight + gap, width: rect.width,
            height: available - firstHeight}, targets);
    }
}

function applyControllerTree(key, output) {
    const tree = treesByContext.get(key);
    if (!tree || !output) {
        return;
    }
    const screen = output.geometry;
    const rect = {x: screen.x + 12, y: screen.y + 12,
        width: screen.width - 24, height: screen.height - 24};
    const targets = [];
    collectTreeGeometries(tree, rect, targets);
    // Grow coverage first, then shrink or move the displaced leaves. This
    // permits brief overlap during a structural edit but never exposes the
    // wallpaper as an intermediate hole while KWin processes each geometry.
    targets.sort(function (a, b) {
        const aFrame = a.window.frameGeometry;
        const bFrame = b.window.frameGeometry;
        const aCurrent = isUsableGeometry(aFrame) ? aFrame : a.geometry;
        const bCurrent = isUsableGeometry(bFrame) ? bFrame : b.geometry;
        const aGrowth = a.geometry.width * a.geometry.height -
            aCurrent.width * aCurrent.height;
        const bGrowth = b.geometry.width * b.geometry.height -
            bCurrent.width * bCurrent.height;
        return bGrowth - aGrowth;
    });
    applyingControllerGeometry = true;
    try {
        targets.forEach(function (target) {
            // PlasmaZones' floating handoff prevents its native autotiler from
            // racing this tree, but autotileKeepFloatingAbove would otherwise
            // place these pseudo-floating tiles above auto-hide Plasma docks.
            // Real user/rule-floated windows never enter this target list.
            if (!target.window || target.window.deleted) {
                return;
            }
            target.window.keepAbove = false;
            target.window.frameGeometry = target.geometry;
        });
    } finally {
        applyingControllerGeometry = false;
    }
}

function removeWindowFromTree(node, window) {
    if (!node) {
        return null;
    }
    if (isLeaf(node)) {
        return node.window === window ? null : node;
    }
    node.first = removeWindowFromTree(node.first, window);
    node.second = removeWindowFromTree(node.second, window);
    if (!node.first) {
        return node.second;
    }
    if (!node.second) {
        return node.first;
    }
    return node;
}

function oldestLeaf(node) {
    const leaves = [];
    collectLeaves(node, leaves);
    if (leaves.length === 0) {
        return null;
    }
    leaves.sort(function (a, b) {
        return Number(openedOrder.get(a.window) || Number.MAX_SAFE_INTEGER) -
            Number(openedOrder.get(b.window) || Number.MAX_SAFE_INTEGER);
    });
    return leaves[0];
}

// Removing a leaf from a conventional BSP promotes its complete sibling
// subtree. That is compact, but it also destroys the visual role of the
// vacated tile. For close/minimize/hide, keep the parent split whenever the
// sibling contains multiple leaves: promote its oldest window into the empty
// side and collapse only the smaller sibling subtree. Structural moves still
// use removeWindowFromTree() so an explicit rearrangement remains direct.
function removeWindowPreservingShape(node, window) {
    if (!node) {
        return null;
    }
    if (isLeaf(node)) {
        return node.window === window ? null : node;
    }

    if (treeContainsWindow(node.first, window)) {
        node.first = removeWindowPreservingShape(node.first, window);
        if (!node.first) {
            if (node.second && !isLeaf(node.second)) {
                const promoted = oldestLeaf(node.second);
                node.second = removeWindowFromTree(node.second,
                    promoted.window);
                node.first = promoted;
                return node;
            }
            return node.second;
        }
        return node;
    }

    if (treeContainsWindow(node.second, window)) {
        node.second = removeWindowPreservingShape(node.second, window);
        if (!node.second) {
            if (node.first && !isLeaf(node.first)) {
                const promoted = oldestLeaf(node.first);
                node.first = removeWindowFromTree(node.first,
                    promoted.window);
                node.second = promoted;
                return node;
            }
            return node.first;
        }
    }
    return node;
}

function treeContainsWindow(node, window) {
    if (!node) {
        return false;
    }
    if (isLeaf(node)) {
        return node.window === window;
    }
    return treeContainsWindow(node.first, window) ||
        treeContainsWindow(node.second, window);
}

function collectLeaves(node, leaves) {
    if (!node) {
        return;
    }
    if (isLeaf(node)) {
        leaves.push(node);
        return;
    }
    collectLeaves(node.first, leaves);
    collectLeaves(node.second, leaves);
}

function splitLeaf(node, target, window) {
    if (isLeaf(node)) {
        if (node !== target) {
            return node;
        }
        const nodeFrame = node.window.frameGeometry;
        const windowFrame = window.frameGeometry;
        const rect = isUsableGeometry(nodeFrame) ? nodeFrame :
            (isUsableGeometry(windowFrame) ? windowFrame :
                {width: 1, height: 1});
        return {window: null,
            orientation: rect.width >= rect.height ? "v" : "h",
            ratio: 0.5, first: node, second: leaf(window)};
    }
    node.first = splitLeaf(node.first, target, window);
    node.second = splitLeaf(node.second, target, window);
    return node;
}

function insertWindowBalanced(node, window) {
    if (!node) {
        return leaf(window);
    }
    const leaves = [];
    collectLeaves(node, leaves);
    let target = leaves[0];
    let largestArea = -1;
    leaves.forEach(function (candidate) {
        const frame = candidate.window.frameGeometry;
        const rect = isUsableGeometry(frame) ? frame :
            {width: 1, height: 1};
        const area = rect.width * rect.height;
        if (area > largestArea) {
            largestArea = area;
            target = candidate;
        }
    });
    return splitLeaf(node, target, window);
}

function insertWindowAtFocusedLeaf(node, window, focusedWindow) {
    if (!node) {
        return leaf(window);
    }
    const leaves = [];
    collectLeaves(node, leaves);
    const focusedLeaf = leaves.find(function (candidate) {
        return candidate.window === focusedWindow;
    });
    if (focusedLeaf) {
        return splitLeaf(node, focusedLeaf, window);
    }
    return insertWindowBalanced(node, window);
}

function pathToWindow(node, window, path) {
    if (!node) {
        return false;
    }
    if (isLeaf(node)) {
        return node.window === window;
    }
    path.push({node: node, side: "first"});
    if (pathToWindow(node.first, window, path)) {
        return true;
    }
    path.pop();
    path.push({node: node, side: "second"});
    if (pathToWindow(node.second, window, path)) {
        return true;
    }
    path.pop();
    return false;
}

function resizeManagedWindow(window, axis, direction, fraction) {
    const key = controllerManaged.get(window);
    const tree = key ? treesByContext.get(key) : null;
    if (!tree) {
        return false;
    }
    const path = [];
    if (!pathToWindow(tree, window, path)) {
        return false;
    }
    const orientation = axis === "width" ? "v" : "h";
    for (let index = path.length - 1; index >= 0; index--) {
        const step = path[index];
        if (step.node.orientation !== orientation) {
            continue;
        }
        const signedDelta = step.side === "first" ?
            direction * fraction : -direction * fraction;
        step.node.ratio = Math.max(0.1,
            Math.min(0.9, step.node.ratio + signedDelta));
        applyControllerTree(key, window.output);
        return true;
    }
    return false;
}

function adoptOmarchyWindows(preferredTarget) {
    const grouped = new Map();
    workspace.windowList().forEach(function (window) {
        if (!isTilingCandidate(window) ||
                window === scratchpadWindow || userFloated.has(window) ||
                isRuleFloated(window) ||
                !windowIsInOmarchy(window)) {
            return;
        }
        const screenId = screenIdForWindow(window);
        const key = contextKey(screenId, desktopNumber(window));
        if (!grouped.has(key)) {
            grouped.set(key, {windows: [], output: window.output});
        }
        grouped.get(key).windows.push(window);
    });

    grouped.forEach(function (group, key) {
        if (!treesByContext.has(key)) {
            treesByContext.set(key,
                buildTree(group.windows.filter(function (window) {
                    return !window.fullScreen;
                }), group.output.geometry));
        }
        group.windows.forEach(function (window) {
            if (!window.fullScreen &&
                    !treeContainsWindow(treesByContext.get(key), window)) {
                const focusedTarget = preferredTarget || lastFocusedWindow ||
                    workspace.activeWindow;
                treesByContext.set(key,
                    insertWindowAtFocusedLeaf(treesByContext.get(key), window,
                        focusedTarget));
            }
            if (controllerManaged.has(window)) {
                return;
            }
            controllerManaged.set(window, key);
            callDBus(SERVICE, OBJECT, TRACKING_INTERFACE,
                "setWindowFloatingForScreen", plasmaZonesWindowId(window),
                String(screenIdForWindow(window)), true,
                function () { applyControllerTree(key, group.output); });
        });
        applyControllerTree(key, group.output);
    });
}

function adoptWindowAtFocusedLeaf(window, focusedWindow) {
    if (!isTilingCandidate(window) || !focusedWindow ||
            !controllerManaged.has(focusedWindow) ||
            !windowIsInOmarchy(focusedWindow) ||
            desktopNumber(window) !== desktopNumber(focusedWindow) ||
            window === scratchpadWindow || userFloated.has(window) ||
            isRuleFloated(window)) {
        return false;
    }
    const key = controllerManaged.get(focusedWindow);
    const output = focusedWindow.output;
    const screenId = screenIdForWindow(focusedWindow);
    if (!key || !output || screenId === undefined) {
        return false;
    }

    if (!treeContainsWindow(treesByContext.get(key), window)) {
        treesByContext.set(key, insertWindowAtFocusedLeaf(
            treesByContext.get(key), window, focusedWindow));
    }
    controllerManaged.set(window, key);
    window.keepAbove = false;
    applyControllerTree(key, output);
    callDBus(SERVICE, OBJECT, TRACKING_INTERFACE,
        "setWindowFloatingForScreen", plasmaZonesWindowId(window),
        String(screenId), true, function () {
            applyControllerTree(key, output);
        });
    log("inserted " + plasmaZonesWindowId(window) +
        " at focused leaf " + plasmaZonesWindowId(focusedWindow) +
        " on " + String(output.name));
    return true;
}

function screenIdForWindow(window) {
    const connector = window && window.output ? String(window.output.name) : "";
    return screenIdsByConnector.get(connector);
}

function windowIsInOmarchy(window) {
    const screenId = screenIdForWindow(window);
    return screenId !== undefined &&
        modesByContext.get(contextKey(screenId, desktopNumber(window))) ===
            OMARCHY_MODE;
}

function activeNormalWindow() {
    const window = workspace.activeWindow;
    if (!isTilingCandidate(window) ||
            !windowIsInOmarchy(window)) {
        return null;
    }
    return window;
}

function retileWindowScreen(window) {
    const screenId = screenIdForWindow(window);
    if (screenId !== undefined) {
        callDBus(SERVICE, OBJECT, TILING_INTERFACE, "retile",
            String(screenId), function () {});
    }
}

function resizeFocused(axis, direction, fraction) {
    const window = activeNormalWindow();
    if (!window || window.fullScreen) {
        return;
    }

    if (controllerManaged.has(window)) {
        resizeManagedWindow(window, axis, direction, fraction);
        return;
    }

    const oldGeometry = copyGeometry(window.frameGeometry);
    const outputGeometry = window.output && window.output.geometry ?
        window.output.geometry : oldGeometry;
    const basis = axis === "width" ? outputGeometry.width :
        outputGeometry.height;
    const delta = Math.max(16, Math.round(basis * fraction)) * direction;
    const nextGeometry = copyGeometry(oldGeometry);

    // Moving the right or bottom edge is deterministic and maps directly to
    // the ancestor split that owns that edge in PlasmaZones' memory engine.
    if (axis === "width") {
        nextGeometry.width = Math.max(80, oldGeometry.width + delta);
    } else {
        nextGeometry.height = Math.max(80, oldGeometry.height + delta);
    }

    if (nextGeometry.width === oldGeometry.width &&
            nextGeometry.height === oldGeometry.height) {
        return;
    }

    window.frameGeometry = nextGeometry;

    if (floatingWindows.has(plasmaZonesWindowId(window))) {
        return;
    }

    callDBus(SERVICE, OBJECT, TRACKING_INTERFACE, "notifyWindowResized",
        plasmaZonesWindowId(window),
        Math.round(oldGeometry.x), Math.round(oldGeometry.y),
        Math.round(oldGeometry.width), Math.round(oldGeometry.height),
        Math.round(nextGeometry.x), Math.round(nextGeometry.y),
        Math.round(nextGeometry.width), Math.round(nextGeometry.height),
        function () {});
}

function toggleFullscreen() {
    const window = activeNormalWindow();
    if (!window) {
        return;
    }
    if (window.fullScreen) {
        if (controllerManaged.has(window)) {
            const key = controllerManaged.get(window);
            if (!treeContainsWindow(treesByContext.get(key), window)) {
                treesByContext.set(key,
                    insertWindowBalanced(treesByContext.get(key), window));
            }
            pendingTreeRestore.set(window, key);
        }
        window.fullScreen = false;
        if (!controllerManaged.has(window)) {
            retileWindowScreen(window);
        }
    } else {
        window.fullScreen = true;
    }
}

function toggleFullWidth() {
    const window = activeNormalWindow();
    if (!window || window.fullScreen) {
        return;
    }
    if (horizontallyMaximized.has(window)) {
        if (controllerManaged.has(window)) {
            pendingTreeRestore.set(window, controllerManaged.get(window));
        }
        horizontallyMaximized.delete(window);
        window.setMaximize(false, false);
        if (!controllerManaged.has(window)) {
            retileWindowScreen(window);
        }
    } else {
        horizontallyMaximized.set(window, true);
        window.setMaximize(false, true);
    }
}

function closeFocused() {
    const window = activeNormalWindow();
    if (!window) {
        return;
    }
    const key = controllerManaged.get(window);
    if (key) {
        treesByContext.set(key,
            removeWindowPreservingShape(treesByContext.get(key), window));
        controllerManaged.delete(window);
        closingWindows.set(window, true);
        applyControllerTree(key, window.output);
    }
    window.closeWindow();
}

function focusDirection(direction) {
    const source = activeNormalWindow();
    if (!source) {
        return;
    }
    // Keep intra-output navigation intuitive. Only cross an output boundary
    // when there is no eligible pane farther in that direction on the active
    // output, matching Hyprland's edge-navigation behavior.
    let target = directionalNeighbor(source, direction, "same");
    if (!target && touchesOutputEdge(source, direction)) {
        target = directionalNeighbor(source, direction, "other");
    }
    if (target) {
        workspace.activeWindow = target;
    }
}

function toggleFocusedFloat() {
    const window = activeNormalWindow();
    if (!window) {
        return;
    }
    const oldKey = controllerManaged.get(window);
    if (oldKey) {
        treesByContext.set(oldKey,
            removeWindowFromTree(treesByContext.get(oldKey), window));
        controllerManaged.delete(window);
        userFloated.set(window, true);
        applyControllerTree(oldKey, window.output);
        return;
    }
    if (window === scratchpadWindow || isRuleFloated(window)) {
        return;
    }
    userFloated.delete(window);
    const screenId = screenIdForWindow(window);
    const key = contextKey(screenId, desktopNumber(window));
    treesByContext.set(key,
        insertWindowBalanced(treesByContext.get(key), window));
    controllerManaged.set(window, key);
    applyControllerTree(key, window.output);
}

function rectanglesOverlapOnAxis(a, b, axis) {
    if (axis === "x") {
        return Math.max(a.x, b.x) <
            Math.min(a.x + a.width, b.x + b.width);
    }
    return Math.max(a.y, b.y) <
        Math.min(a.y + a.height, b.y + b.height);
}

function touchesOutputEdge(window, direction) {
    if (!window || !window.output || !window.output.geometry ||
            !isUsableGeometry(window.frameGeometry)) {
        return false;
    }
    const frame = window.frameGeometry;
    const output = window.output.geometry;
    if (direction === "left") {
        return Math.abs(frame.x - output.x) <= OUTPUT_EDGE_TOLERANCE;
    }
    if (direction === "right") {
        return Math.abs(frame.x + frame.width -
            (output.x + output.width)) <= OUTPUT_EDGE_TOLERANCE;
    }
    if (direction === "up") {
        return Math.abs(frame.y - output.y) <= OUTPUT_EDGE_TOLERANCE;
    }
    if (direction === "down") {
        return Math.abs(frame.y + frame.height -
            (output.y + output.height)) <= OUTPUT_EDGE_TOLERANCE;
    }
    return false;
}

function directionalNeighbor(source, direction, outputScope) {
    outputScope = outputScope || "same";
    const sourceGeometry = source.frameGeometry;
    const sourceCenterX = sourceGeometry.x + sourceGeometry.width / 2;
    const sourceCenterY = sourceGeometry.y + sourceGeometry.height / 2;
    let best = null;
    let bestScore = Number.MAX_VALUE;

    workspace.windowList().forEach(function (candidate) {
        const sameOutput = candidate.output === source.output;
        if (candidate === source || !isTilingCandidate(candidate) ||
                (outputScope === "same" && !sameOutput) ||
                (outputScope === "other" && sameOutput) ||
                desktopNumber(candidate) !== desktopNumber(source) ||
                (!controllerManaged.has(candidate) &&
                 floatingWindows.has(plasmaZonesWindowId(candidate)))) {
            return;
        }

        const geometry = candidate.frameGeometry;
        const centerX = geometry.x + geometry.width / 2;
        const centerY = geometry.y + geometry.height / 2;
        const dx = centerX - sourceCenterX;
        const dy = centerY - sourceCenterY;
        let primary;
        let secondary;
        let overlaps;

        if (direction === "left" && dx < 0) {
            primary = -dx;
            secondary = Math.abs(dy);
            overlaps = rectanglesOverlapOnAxis(sourceGeometry, geometry, "y");
        } else if (direction === "right" && dx > 0) {
            primary = dx;
            secondary = Math.abs(dy);
            overlaps = rectanglesOverlapOnAxis(sourceGeometry, geometry, "y");
        } else if (direction === "up" && dy < 0) {
            primary = -dy;
            secondary = Math.abs(dx);
            overlaps = rectanglesOverlapOnAxis(sourceGeometry, geometry, "x");
        } else if (direction === "down" && dy > 0) {
            primary = dy;
            secondary = Math.abs(dx);
            overlaps = rectanglesOverlapOnAxis(sourceGeometry, geometry, "x");
        } else {
            return;
        }

        const score = primary + secondary * 2 + (overlaps ? 0 : 100000);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    });
    return best;
}

function moveFocused(direction) {
    const source = activeNormalWindow();
    if (!source || source.fullScreen || !controllerManaged.has(source)) {
        return false;
    }
    const target = directionalNeighbor(source, direction);
    const key = controllerManaged.get(source);
    if (!target || controllerManaged.get(target) !== key) {
        return false;
    }

    const leaves = [];
    collectLeaves(treesByContext.get(key), leaves);
    const sourceLeaf = leaves.find(function (candidate) {
        return candidate.window === source;
    });
    const targetLeaf = leaves.find(function (candidate) {
        return candidate.window === target;
    });
    if (!sourceLeaf || !targetLeaf) {
        return false;
    }

    // Directional movement is a pane swap, not a tree edit. Only the two leaf
    // occupants change; split topology, orientation, ratios, and geometries
    // remain byte-for-byte equivalent.
    sourceLeaf.window = target;
    targetLeaf.window = source;
    applyControllerTree(key, source.output);
    workspace.activeWindow = source;
    return true;
}

function moveFocusedAcrossLayout(direction) {
    const source = activeNormalWindow();
    if (!source || source.fullScreen) {
        return;
    }
    if (moveFocused(direction)) {
        return;
    }
    if (touchesOutputEdge(source, direction)) {
        moveFocusedToScreen(direction);
    }
}

function directionalOutput(sourceOutput, direction) {
    if (!sourceOutput || !sourceOutput.geometry) {
        return null;
    }
    const source = sourceOutput.geometry;
    const sourceCenterX = source.x + source.width / 2;
    const sourceCenterY = source.y + source.height / 2;
    let best = null;
    let bestScore = Number.MAX_VALUE;

    workspace.screenOrder.forEach(function (candidate) {
        if (candidate === sourceOutput || !candidate.geometry) {
            return;
        }
        const geometry = candidate.geometry;
        const dx = geometry.x + geometry.width / 2 - sourceCenterX;
        const dy = geometry.y + geometry.height / 2 - sourceCenterY;
        let primary;
        let secondary;
        let overlaps;

        if (direction === "left" && dx < 0) {
            primary = -dx;
            secondary = Math.abs(dy);
            overlaps = rectanglesOverlapOnAxis(source, geometry, "y");
        } else if (direction === "right" && dx > 0) {
            primary = dx;
            secondary = Math.abs(dy);
            overlaps = rectanglesOverlapOnAxis(source, geometry, "y");
        } else if (direction === "up" && dy < 0) {
            primary = -dy;
            secondary = Math.abs(dx);
            overlaps = rectanglesOverlapOnAxis(source, geometry, "x");
        } else if (direction === "down" && dy > 0) {
            primary = dy;
            secondary = Math.abs(dx);
            overlaps = rectanglesOverlapOnAxis(source, geometry, "x");
        } else {
            return;
        }

        const horizontal = direction === "left" || direction === "right";
        const primarilyAligned = horizontal ?
            Math.abs(dx) >= Math.abs(dy) : Math.abs(dy) >= Math.abs(dx);
        if (!overlaps && !primarilyAligned) {
            return;
        }
        const score = primary + secondary * 2 + (overlaps ? 0 : 100000);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    });
    return best;
}

function moveFocusedToScreen(direction) {
    const window = workspace.activeWindow;
    if (!isTilingCandidate(window) || window.fullScreen || !window.output) {
        return;
    }
    if (pendingScreenTransfers.has(window)) {
        finalizePendingScreenTransfer(window);
        return;
    }
    const sourceOutput = window.output;
    const targetOutput = directionalOutput(sourceOutput, direction);
    if (!targetOutput) {
        return;
    }

    const targetScreenId = screenIdsByConnector.get(String(targetOutput.name));
    if (targetScreenId === undefined) {
        log("cannot transfer: no PlasmaZones identity for " +
            String(targetOutput.name));
        return;
    }
    const desktop = desktopNumber(window);
    const targetKey = contextKey(targetScreenId, desktop);
    const targetMode = modesByContext.get(targetKey);
    const needsManagedDestination = targetMode === OMARCHY_MODE &&
        window !== scratchpadWindow && !userFloated.has(window) &&
        !isRuleFloated(window);

    const oldKey = controllerManaged.get(window);
    if (oldKey) {
        treesByContext.set(oldKey,
            removeWindowPreservingShape(treesByContext.get(oldKey), window));
        controllerManaged.delete(window);
        applyControllerTree(oldKey, sourceOutput);
    }

    // KWin's output change is asynchronous. Keep destination membership out
    // of the tree until both output and frameGeometry have converged; some
    // clients briefly expose an undefined frame while crossing outputs.
    pendingScreenTransfers.set(window, {
        sourceOutput: sourceOutput,
        targetOutput: targetOutput,
        targetScreenId: String(targetScreenId),
        targetKey: targetKey,
        targetMode: targetMode,
        needsManagedDestination: needsManagedDestination,
        trackingRequested: false,
        trackingReady: !needsManagedDestination
    });

    // Let KWin's outputChanged reach PlasmaZones first. Its native handler
    // releases the source engine and re-adds the live window at the target;
    // declaring the target floating before this point is racy because that
    // source cleanup clears the declaration again.
    workspace.sendClientToScreen(window, targetOutput);
    finalizePendingScreenTransfer(window);
    workspace.activeWindow = window;
    log("requested " + plasmaZonesWindowId(window) + " " + direction +
        " from " + String(sourceOutput.name) + " to " +
        String(targetOutput.name));
}

function finalizePendingScreenTransfer(window) {
    const transfer = pendingScreenTransfers.get(window);
    if (!transfer) {
        return false;
    }
    if (window.deleted) {
        pendingScreenTransfers.delete(window);
        return true;
    }
    if (window.output !== transfer.targetOutput ||
            !isUsableGeometry(window.frameGeometry)) {
        return false;
    }

    if (transfer.needsManagedDestination && !transfer.trackingReady) {
        if (!transfer.trackingRequested) {
            transfer.trackingRequested = true;
            callDBus(SERVICE, OBJECT, TRACKING_INTERFACE,
                "setWindowFloatingForScreen", plasmaZonesWindowId(window),
                transfer.targetScreenId, true, function () {
                    const current = pendingScreenTransfers.get(window);
                    if (!current) {
                        return;
                    }
                    current.trackingReady = true;
                    // A delayed source reflow can race the D-Bus reply. Now
                    // that the destination owns the floating state, repeat the
                    // physical hop if necessary and finish on its next signal.
                    if (window.output !== current.targetOutput) {
                        workspace.sendClientToScreen(window,
                            current.targetOutput);
                    }
                    finalizePendingScreenTransfer(window);
                });
        }
        return false;
    }

    pendingScreenTransfers.delete(window);
    if (transfer.targetMode === OMARCHY_MODE &&
            window !== scratchpadWindow && !userFloated.has(window) &&
            !isRuleFloated(window)) {
        if (!treeContainsWindow(treesByContext.get(transfer.targetKey),
                window)) {
            treesByContext.set(transfer.targetKey,
                insertWindowBalanced(treesByContext.get(transfer.targetKey),
                    window));
        }
        controllerManaged.set(window, transfer.targetKey);
        window.keepAbove = false;
        applyControllerTree(transfer.targetKey, transfer.targetOutput);
    } else if (transfer.targetMode === 0) {
        requestFancyAdaptiveReflow();
    }
    workspace.activeWindow = window;
    log("completed transfer of " + plasmaZonesWindowId(window) + " from " +
        String(transfer.sourceOutput.name) + " to " +
        String(transfer.targetOutput.name));
    return true;
}

function desktopAt(number) {
    const index = number - 1;
    return index >= 0 && index < workspace.desktops.length ?
        workspace.desktops[index] : null;
}

function ensureOmarchyDesktops() {
    while (workspace.desktops.length < 4) {
        const number = workspace.desktops.length + 1;
        workspace.createDesktop(workspace.desktops.length,
            "Workspace " + number);
    }
}

function switchDesktop(number) {
    const desktop = desktopAt(number);
    if (desktop) {
        workspace.currentDesktop = desktop;
        refreshModeCache();
    }
}

function moveFocusedToDesktop(number) {
    const window = activeNormalWindow();
    const desktop = desktopAt(number);
    if (!window || !desktop) {
        return;
    }
    const oldKey = controllerManaged.get(window);
    if (oldKey) {
        treesByContext.set(oldKey,
            removeWindowPreservingShape(treesByContext.get(oldKey), window));
        controllerManaged.delete(window);
        applyControllerTree(oldKey, window.output);
    }
    window.onAllDesktops = false;
    window.desktops = [desktop];
    workspace.currentDesktop = desktop;
    workspace.activeWindow = window;
    refreshModeCache();
}

function centerScratchpad(window) {
    const outputGeometry = window.output && window.output.geometry ?
        window.output.geometry : window.frameGeometry;
    const width = Math.round(outputGeometry.width * 0.72);
    const height = Math.round(outputGeometry.height * 0.72);
    window.frameGeometry = {
        x: Math.round(outputGeometry.x + (outputGeometry.width - width) / 2),
        y: Math.round(outputGeometry.y + (outputGeometry.height - height) / 2),
        width: width,
        height: height
    };
}

function sendFocusedToScratchpad() {
    const window = activeNormalWindow();
    if (!window) {
        return;
    }
    if (scratchpadWindow === window && !controllerManaged.has(window)) {
        const screenId = screenIdForWindow(window);
        const key = contextKey(screenId, desktopNumber(window));
        treesByContext.set(key,
            insertWindowBalanced(treesByContext.get(key), window));
        controllerManaged.set(window, key);
        window.onAllDesktops = false;
        window.minimized = false;
        scratchpadWindow = null;
        applyControllerTree(key, window.output);
        return;
    }

    const oldKey = controllerManaged.get(window);
    if (oldKey) {
        treesByContext.set(oldKey,
            removeWindowFromTree(treesByContext.get(oldKey), window));
        controllerManaged.delete(window);
        applyControllerTree(oldKey, window.output);
    }
    scratchpadWindow = window;
    const windowId = plasmaZonesWindowId(window);
    const screenId = screenIdForWindow(window);
    floatingWindows.set(windowId, true);
    callDBus(SERVICE, OBJECT, TRACKING_INTERFACE,
        "setWindowFloatingForScreen", windowId, String(screenId), true,
        function () {
            window.onAllDesktops = true;
            centerScratchpad(window);
            window.minimized = true;
        });
}

function toggleScratchpad() {
    if (!scratchpadWindow) {
        return;
    }
    if (scratchpadWindow.minimized) {
        scratchpadWindow.minimized = false;
        scratchpadWindow.onAllDesktops = true;
        centerScratchpad(scratchpadWindow);
        workspace.activeWindow = scratchpadWindow;
    } else {
        scratchpadWindow.minimized = true;
    }
}

function registerOmarchyShortcuts() {
    const resizeBindings = [
        ["PZH Shrink Width", "Shrink focused tile width", "Meta+-", "width", -1, RESIZE_STEP],
        ["PZH Grow Width", "Grow focused tile width", "Meta+=", "width", 1, RESIZE_STEP],
        ["PZH Shrink Height", "Shrink focused tile height", "Meta+Shift+-", "height", -1, RESIZE_STEP],
        ["PZH Grow Height", "Grow focused tile height", "Meta+Shift+=", "height", 1, RESIZE_STEP],
        ["PZH Fine Shrink Width", "Fine shrink focused tile width", "Meta+Alt+-", "width", -1, RESIZE_STEP_FINE],
        ["PZH Fine Grow Width", "Fine grow focused tile width", "Meta+Alt+=", "width", 1, RESIZE_STEP_FINE],
        ["PZH Fine Shrink Height", "Fine shrink focused tile height", "Meta+Alt+Shift+-", "height", -1, RESIZE_STEP_FINE],
        ["PZH Fine Grow Height", "Fine grow focused tile height", "Meta+Alt+Shift+=", "height", 1, RESIZE_STEP_FINE],
        ["PZH Coarse Shrink Width", "Coarse shrink focused tile width", "Meta+Ctrl+-", "width", -1, RESIZE_STEP_COARSE],
        ["PZH Coarse Grow Width", "Coarse grow focused tile width", "Meta+Ctrl+=", "width", 1, RESIZE_STEP_COARSE],
        ["PZH Coarse Shrink Height", "Coarse shrink focused tile height", "Meta+Ctrl+Shift+-", "height", -1, RESIZE_STEP_COARSE],
        ["PZH Coarse Grow Height", "Coarse grow focused tile height", "Meta+Ctrl+Shift+=", "height", 1, RESIZE_STEP_COARSE]
    ];

    resizeBindings.forEach(function (binding) {
        registerShortcut(binding[0], binding[1], binding[2], function () {
            resizeFocused(binding[3], binding[4], binding[5]);
        });
    });
    registerShortcut("PZH Fullscreen", "Toggle focused window fullscreen",
        "Meta+F", toggleFullscreen);
    registerShortcut("PZH Full Width", "Toggle focused window full width",
        "Meta+Alt+F", toggleFullWidth);
    registerShortcut("PZH Close Window", "Close focused window",
        "Meta+Q", closeFocused);
    ["Left", "Right", "Up", "Down"].forEach(function (direction) {
        registerShortcut("PZH Focus " + direction,
            "Focus tile " + direction.toLowerCase(),
            "Meta+" + direction, function () {
                focusDirection(direction.toLowerCase());
            });
        registerShortcut("PZH Move " + direction,
            "Move focused window " + direction.toLowerCase() +
                " through panes and screens",
            "Meta+Shift+" + direction, function () {
                moveFocusedAcrossLayout(direction.toLowerCase());
            });
        // Unbound test hook: public movement uses the single Hyprland-style
        // Meta+Shift+Arrow path above, while live tests can still exercise the
        // raw asynchronous output-transfer transaction in isolation.
        registerShortcut("PZH Direct Screen " + direction,
            "Test-only direct screen transfer " + direction.toLowerCase(),
            "", function () {
                moveFocusedToScreen(direction.toLowerCase());
            });
    });
    for (let number = 1; number <= 4; number++) {
        registerShortcut("PZH Workspace " + number,
            "Switch to workspace " + number, "Meta+" + number,
            function () { switchDesktop(number); });
        registerShortcut("PZH Move to Workspace " + number,
            "Move focused window to workspace " + number,
            "Meta+Shift+" + number,
            function () { moveFocusedToDesktop(number); });
    }
    registerShortcut("PZH Toggle Scratchpad", "Show or hide scratchpad",
        "Meta+S", toggleScratchpad);
    registerShortcut("PZH Send to Scratchpad",
        "Send focused window to scratchpad", "Meta+Shift+S",
        sendFocusedToScratchpad);
    registerShortcut("PZH Toggle Float", "Toggle focused window floating",
        "Meta+T", toggleFocusedFloat);
    // Internal action invoked by plasmazones-mode-toggle after the mode and
    // layout assignment have converged. It intentionally has no user key.
    registerShortcut("PZH Fancy Adaptive Reflow",
        "Distribute visible windows across the FancyZones grid", "",
        requestFancyAdaptiveReflow);
}

function desktopNumber(window) {
    if (window.desktops && window.desktops.length > 0) {
        return window.desktops[0].x11DesktopNumber;
    }
    return workspace.currentDesktop.x11DesktopNumber;
}

function plasmaZonesWindowId(window) {
    let appId = String(window.desktopFileName || "").trim();
    if (!appId) {
        const windowClass = String(window.resourceClass ||
            window.resourceName || "").trim();
        const separator = windowClass.lastIndexOf(" ");
        appId = separator >= 0 ? windowClass.slice(separator + 1) :
            windowClass;
    }
    appId = appId.toLowerCase();
    const instanceId = String(window.internalId || "")
        .replace(/[{}]/g, "")
        .toLowerCase();
    return appId + "|" + instanceId;
}

function gestureIsCurrent(window, generation) {
    const gesture = gestures.get(window);
    return gesture && gesture.generation === generation;
}

function contextKey(screenId, desktop) {
    return String(screenId) + "|" + String(desktop);
}

function outputForContextKey(key) {
    let match = null;
    workspace.screenOrder.forEach(function (output) {
        const screenId = screenIdsByConnector.get(String(output.name));
        if (screenId !== undefined &&
                String(key).indexOf(String(screenId) + "|") === 0) {
            match = output;
        }
    });
    return match;
}

function refreshOutputIdentity(output) {
    const connector = output ? String(output.name) : "";
    if (!connector) {
        return;
    }

    callDBus(SERVICE, OBJECT, SCREEN_INTERFACE, "getScreenId", connector,
        function (screenId) {
            if (!screenId) {
                return;
            }
            screenId = String(screenId);
            screenIdsByConnector.set(connector, screenId);
            log("mapped " + connector + " to " + screenId);
        });
}

function refreshModeCache() {
    workspace.screenOrder.forEach(function (output) {
        refreshOutputIdentity(output);
    });

    // getScreenStates is PlasmaZones' effective, activity-aware answer.
    // getModeForScreenDesktop only reads the underlying desktop assignment
    // and can therefore report FancyZones while an activity override has
    // Omarchy active on the same output.
    callDBus(SERVICE, OBJECT, LAYOUT_INTERFACE, "getScreenStates",
        function (statesJson) {
            let states;
            try {
                states = JSON.parse(String(statesJson));
            } catch (error) {
                log("could not parse effective screen states: " + error);
                return;
            }
            modesByContext.clear();
            states.forEach(function (state) {
                modesByContext.set(contextKey(state.screenId,
                    state.virtualDesktop), Number(state.mode));
                log("cached effective mode " + state.mode + " for " +
                    state.screenId + " on desktop " +
                    state.virtualDesktop);
            });
            adoptOmarchyWindows();
        });
}

function refreshFloatingCache() {
    callDBus(SERVICE, OBJECT, TRACKING_INTERFACE, "getFloatingWindows",
        function (windowIds) {
            floatingWindows.clear();
            if (!windowIds) {
                return;
            }
            windowIds.forEach(function (windowId) {
                floatingWindows.set(String(windowId), true);
            });
        });
}

function clearPlasmaZonesDragTransaction() {
    // cancelSnap() is intentionally not used here. On an engine-owned screen,
    // cancelling the reorder preview makes PlasmaZones' endDrag fallback emit
    // ApplyFloat. Clearing the transaction instead makes the later endDrag a
    // harmless window-id mismatch with a NoOp result.
    callDBus(SERVICE, OBJECT, DRAG_INTERFACE,
        "clearForCompositorReconnect", function () {});
}

function restoreGeometry(window, gesture) {
    if (!gesture.locked) {
        return;
    }
    window.frameGeometry = gesture.geometry;
    clearPlasmaZonesDragTransaction();
}

function resolveGesturePolicy(window, gesture) {
    const connector = window.output ? String(window.output.name) : "";
    const screenId = screenIdsByConnector.get(connector);
    const mode = screenId === undefined ? undefined :
        modesByContext.get(contextKey(screenId, gesture.desktop));

    if (mode !== OMARCHY_MODE) {
        log("allowed gesture for " + gesture.windowId + ": mode=" + mode +
            " connector=" + connector);
        refreshModeCache();
        return;
    }

    gesture.screenId = String(screenId);
    if (controllerManaged.has(window)) {
        gesture.locked = true;
        restoreGeometry(window, gesture);
        log("blocked mouse geometry change for " + gesture.windowId +
            " on " + screenId);
    }

    const generation = gesture.generation;
    callDBus(SERVICE, OBJECT, TRACKING_INTERFACE, "isWindowFloating",
        gesture.windowId, function (floating) {
            if (!gestureIsCurrent(window, generation)) {
                return;
            }
            if (Boolean(floating) && !controllerManaged.has(window)) {
                floatingWindows.set(gesture.windowId, true);
                gesture.locked = false;
                log("released floating window " + gesture.windowId);
            } else {
                floatingWindows.delete(gesture.windowId);
                gesture.locked = true;
                restoreGeometry(window, gesture);
            }
        });
}

function moveResizeStarted(window) {
    if (!isTilingCandidate(window)) {
        return;
    }

    const gesture = {
        generation: nextGeneration++,
        geometry: copyGeometry(window.frameGeometry),
        desktop: desktopNumber(window),
        windowId: plasmaZonesWindowId(window),
        screenId: "",
        locked: false
    };
    gestures.set(window, gesture);
    resolveGesturePolicy(window, gesture);
}

function moveResizeStepped(window) {
    const gesture = gestures.get(window);
    if (gesture) {
        restoreGeometry(window, gesture);
    }
}

function moveResizeFinished(window) {
    const gesture = gestures.get(window);
    if (!gesture) {
        return;
    }

    if (gesture.locked) {
        restoreGeometry(window, gesture);
        if (gesture.screenId) {
            callDBus(SERVICE, OBJECT, TILING_INTERFACE, "retile",
                gesture.screenId, function () {});
        }
    }
    gestures.delete(window);
}

function attach(window) {
    if (attachedWindows.has(window)) {
        return;
    }
    attachedWindows.set(window, true);
    if (!openedOrder.has(window)) {
        openedOrder.set(window, nextOpenedOrder++);
    }
    const insertionTarget = lastFocusedWindow || workspace.activeWindow;
    const adoptedAtFocus = adoptWindowAtFocusedLeaf(window, insertionTarget);
    if (!adoptedAtFocus && windowIsInOmarchy(window)) {
        adoptOmarchyWindows(insertionTarget);
    }

    if (window.active) {
        lastFocusedWindow = window;
    }
    if (window.activeChanged && window.activeChanged.connect) {
        window.activeChanged.connect(function () {
            if (window.active && isTilingCandidate(window)) {
                lastFocusedWindow = window;
            }
        });
    }
    if (window.keepAboveChanged && window.keepAboveChanged.connect) {
        window.keepAboveChanged.connect(function () {
            if (controllerManaged.has(window) && window.keepAbove) {
                window.keepAbove = false;
            }
        });
    }

    window.interactiveMoveResizeStarted.connect(function () {
        moveResizeStarted(window);
    });
    window.interactiveMoveResizeStepped.connect(function () {
        moveResizeStepped(window);
    });
    window.interactiveMoveResizeFinished.connect(function () {
        moveResizeFinished(window);
    });
    window.frameGeometryChanged.connect(function () {
        if (pendingScreenTransfers.has(window)) {
            finalizePendingScreenTransfer(window);
            return;
        }
        const restoreKey = pendingTreeRestore.get(window);
        if (restoreKey) {
            pendingTreeRestore.delete(window);
            userFloated.delete(window);
            applyControllerTree(restoreKey, window.output);
            return;
        }

        // PlasmaZones may finish a queued retile or animation after this
        // controller has adopted the window. Omarchy owns final geometry, so
        // immediately restore the tree instead of letting the two engines
        // visibly fight and settle several frames later.
        const managedKey = controllerManaged.get(window);
        if (managedKey && !applyingControllerGeometry &&
                !window.fullScreen && !horizontallyMaximized.has(window)) {
            applyControllerTree(managedKey,
                outputForContextKey(managedKey) || window.output);
        }
    });
    if (window.outputChanged && window.outputChanged.connect) {
        window.outputChanged.connect(function () {
            if (pendingScreenTransfers.has(window)) {
                finalizePendingScreenTransfer(window);
                return;
            }
            const managedKey = controllerManaged.get(window);
            const intendedOutput = managedKey ?
                outputForContextKey(managedKey) : null;
            if (intendedOutput && intendedOutput !== window.output) {
                applyControllerTree(managedKey, intendedOutput);
            }
        });
    }
    const eligibilityChanged = function () {
        const key = controllerManaged.get(window);
        if (!isTilingCandidate(window)) {
            if (key) {
                treesByContext.set(key,
                    removeWindowPreservingShape(treesByContext.get(key),
                        window));
                controllerManaged.delete(window);
                applyControllerTree(key, window.output);
            }
            return;
        }
        if (!key && !closingWindows.has(window) &&
                window !== scratchpadWindow && !userFloated.has(window) &&
                !isRuleFloated(window) && windowIsInOmarchy(window)) {
            const currentTarget = lastFocusedWindow || workspace.activeWindow;
            if (!adoptWindowAtFocusedLeaf(window, currentTarget)) {
                adoptOmarchyWindows(currentTarget);
            }
        }
    };
    ["minimizedChanged", "hiddenChanged", "deletedChanged",
        "skipTaskbarChanged", "skipSwitcherChanged"].forEach(
        function (signalName) {
            const signal = window[signalName];
            if (signal && signal.connect) {
                signal.connect(eligibilityChanged);
            }
        });
    window.closed.connect(function () {
        const managedKey = controllerManaged.get(window);
        if (managedKey) {
            treesByContext.set(managedKey,
                removeWindowPreservingShape(treesByContext.get(managedKey),
                    window));
            controllerManaged.delete(window);
            applyControllerTree(managedKey, window.output);
        }
        gestures.delete(window);
        horizontallyMaximized.delete(window);
        pendingTreeRestore.delete(window);
        pendingScreenTransfers.delete(window);
        closingWindows.delete(window);
        openedOrder.delete(window);
        attachedWindows.delete(window);
        if (scratchpadWindow === window) {
            scratchpadWindow = null;
        }
        if (lastFocusedWindow === window) {
            lastFocusedWindow = null;
        }
    });
}

workspace.windowList().forEach(attach);
workspace.windowAdded.connect(attach);
workspace.currentDesktopChanged.connect(function () {
    refreshModeCache();
    refreshFloatingCache();
});
workspace.screensChanged.connect(refreshModeCache);
workspace.screenOrderChanged.connect(refreshModeCache);
refreshModeCache();
refreshFloatingCache();
ensureOmarchyDesktops();
registerOmarchyShortcuts();
log("loaded; mouse lock and Omarchy keyboard layer are active");
