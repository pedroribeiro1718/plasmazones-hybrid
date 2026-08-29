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
const TILING_INTERFACE = "org.plasmazones.Tiling";
const OMARCHY_MODE = 1;

const attachedWindows = new Map();
const gestures = new Map();
const screenIdsByConnector = new Map();
const modesByContext = new Map();
const floatingWindows = new Map();
const horizontallyMaximized = new Map();
const pendingTreeRestore = new Map();
const controllerManaged = new Map();
const userFloated = new Map();
const treesByContext = new Map();
const closingWindows = new Map();
let nextGeneration = 1;
let scratchpadWindow = null;
let applyingControllerGeometry = false;

const RESIZE_STEP = 0.05;
const RESIZE_STEP_FINE = 0.02;
const RESIZE_STEP_COARSE = 0.10;

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
    const rect = output.geometry;
    const targets = [];
    collectTreeGeometries(tree, {x: rect.x + 12, y: rect.y + 12,
        width: rect.width - 24, height: rect.height - 24}, targets);
    // Grow coverage first, then shrink or move the displaced leaves. This
    // permits brief overlap during a structural edit but never exposes the
    // wallpaper as an intermediate hole while KWin processes each geometry.
    targets.sort(function (a, b) {
        const aCurrent = a.window.frameGeometry;
        const bCurrent = b.window.frameGeometry;
        const aGrowth = a.geometry.width * a.geometry.height -
            aCurrent.width * aCurrent.height;
        const bGrowth = b.geometry.width * b.geometry.height -
            bCurrent.width * bCurrent.height;
        return bGrowth - aGrowth;
    });
    applyingControllerGeometry = true;
    try {
        targets.forEach(function (target) {
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
        const rect = node.window.frameGeometry;
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
        const rect = candidate.window.frameGeometry;
        const area = rect.width * rect.height;
        if (area > largestArea) {
            largestArea = area;
            target = candidate;
        }
    });
    return splitLeaf(node, target, window);
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

function adoptOmarchyWindows() {
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
                treesByContext.set(key,
                    insertWindowBalanced(treesByContext.get(key), window));
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
            removeWindowFromTree(treesByContext.get(key), window));
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
    const target = directionalNeighbor(source, direction);
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

function directionalNeighbor(source, direction) {
    const sourceGeometry = source.frameGeometry;
    const sourceCenterX = sourceGeometry.x + sourceGeometry.width / 2;
    const sourceCenterY = sourceGeometry.y + sourceGeometry.height / 2;
    let best = null;
    let bestScore = Number.MAX_VALUE;

    workspace.windowList().forEach(function (candidate) {
        if (candidate === source || !isTilingCandidate(candidate) ||
                candidate.output !== source.output ||
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
    if (!source || source.fullScreen ||
            (!controllerManaged.has(source) &&
             floatingWindows.has(plasmaZonesWindowId(source)))) {
        return;
    }
    const target = directionalNeighbor(source, direction);
    const screenId = screenIdForWindow(source);
    if (!target || screenId === undefined) {
        return;
    }

    if (controllerManaged.has(source)) {
        const key = controllerManaged.get(source);
        let tree = removeWindowFromTree(treesByContext.get(key), source);
        tree = insertWindowAtTarget(tree, target, source, direction);
        treesByContext.set(key, tree);
        applyControllerTree(key, source.output);
        workspace.activeWindow = source;
        return;
    }

    const sourceId = plasmaZonesWindowId(source);
    const targetId = plasmaZonesWindowId(target);
    const minSize = source.minSize || {width: 0, height: 0};

    // Removal collapses the source's parent, so its sibling immediately fills
    // the hole. Re-inserting after the directional target creates a new local
    // branch there instead of merely exchanging two leaf contents.
    callDBus(SERVICE, OBJECT, TILING_INTERFACE, "releaseWindowTracking",
        sourceId, function () {
            callDBus(SERVICE, OBJECT, TILING_INTERFACE,
                "notifyWindowFocused", targetId, String(screenId),
                function () {
                    callDBus(SERVICE, OBJECT, TILING_INTERFACE,
                        "windowOpened", sourceId, String(screenId),
                        Math.max(0, Math.round(minSize.width || 0)),
                        Math.max(0, Math.round(minSize.height || 0)),
                        function () {
                            workspace.activeWindow = source;
                        });
                });
        });
}

function insertWindowAtTarget(node, target, source, direction) {
    if (!node) {
        return leaf(source);
    }
    if (isLeaf(node)) {
        if (node.window !== target) {
            return node;
        }
        const horizontal = direction === "left" || direction === "right";
        const sourceFirst = direction === "left" || direction === "up";
        return {window: null, orientation: horizontal ? "v" : "h",
            ratio: 0.5,
            first: sourceFirst ? leaf(source) : node,
            second: sourceFirst ? node : leaf(source)};
    }
    node.first = insertWindowAtTarget(node.first, target, source, direction);
    if (!treeContainsWindow(node.first, source)) {
        node.second = insertWindowAtTarget(node.second, target, source,
            direction);
    }
    return node;
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
            removeWindowFromTree(treesByContext.get(oldKey), window));
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
            "Move focused tile " + direction.toLowerCase(),
            "Meta+Shift+" + direction, function () {
                moveFocused(direction.toLowerCase());
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
    if (windowIsInOmarchy(window)) {
        adoptOmarchyWindows();
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
            applyControllerTree(managedKey, window.output);
        }
    });
    const eligibilityChanged = function () {
        const key = controllerManaged.get(window);
        if (!isTilingCandidate(window)) {
            if (key) {
                treesByContext.set(key,
                    removeWindowFromTree(treesByContext.get(key), window));
                controllerManaged.delete(window);
                applyControllerTree(key, window.output);
            }
            return;
        }
        if (!key && !closingWindows.has(window) &&
                window !== scratchpadWindow && !userFloated.has(window) &&
                !isRuleFloated(window) && windowIsInOmarchy(window)) {
            adoptOmarchyWindows();
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
                removeWindowFromTree(treesByContext.get(managedKey), window));
            controllerManaged.delete(window);
            applyControllerTree(managedKey, window.output);
        }
        gestures.delete(window);
        horizontallyMaximized.delete(window);
        pendingTreeRestore.delete(window);
        closingWindows.delete(window);
        attachedWindows.delete(window);
        if (scratchpadWindow === window) {
            scratchpadWindow = null;
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
