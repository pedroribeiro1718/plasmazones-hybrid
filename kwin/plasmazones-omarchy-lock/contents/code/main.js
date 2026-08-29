/*
 * PlasmaZones Omarchy Mouse Lock
 *
 * PlasmaZones mode 0 (FancyZones): no intervention.
 * PlasmaZones mode 1 (Omarchy): cancel interactive mouse move/resize for
 * tiled windows while leaving explicitly floating windows alone.
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
let nextGeneration = 1;

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
    if (!floatingWindows.has(gesture.windowId)) {
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
            if (Boolean(floating)) {
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
    if (!window.normalWindow || !window.managed) {
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

    window.interactiveMoveResizeStarted.connect(function () {
        moveResizeStarted(window);
    });
    window.interactiveMoveResizeStepped.connect(function () {
        moveResizeStepped(window);
    });
    window.interactiveMoveResizeFinished.connect(function () {
        moveResizeFinished(window);
    });
    window.closed.connect(function () {
        gestures.delete(window);
        attachedWindows.delete(window);
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
log("loaded; preloading output modes for synchronous gesture blocking");

