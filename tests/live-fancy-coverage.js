/* Live FancyZones invariant probe. Loaded by live-fancy-coverage.sh. */

function candidate(window) {
    const onDesktop = window.onAllDesktops ||
        (window.desktops && window.desktops.some(desktop =>
            desktop === workspace.currentDesktop));
    return Boolean(window && window.normalWindow && window.managed &&
        !window.minimized && !window.hidden && !window.deleted &&
        !window.skipTaskbar && !window.skipSwitcher &&
        !window.popupWindow && !window.dialog && !window.modal &&
        !window.transient && onDesktop);
}

function zoneRect(output, index) {
    const screen = output.geometry;
    const column = index % 3;
    const row = Math.floor(index / 3);
    const left = column === 0 ? screen.x + 12 :
        Math.round(screen.x + screen.width * column / 3 + 4);
    const right = column === 2 ? screen.x + screen.width - 12 :
        Math.round(screen.x + screen.width * (column + 1) / 3 - 4);
    const top = row === 0 ? screen.y + 12 :
        Math.round(screen.y + screen.height / 2 + 4);
    const bottom = row === 1 ? screen.y + screen.height - 12 :
        Math.round(screen.y + screen.height / 2 - 4);
    return {x: left, y: top, right: right, bottom: bottom};
}

for (const output of workspace.screenOrder) {
    const windows = workspace.windowList().filter(window =>
        candidate(window) && window.output === output);
    if (windows.length === 0) {
        console.info(`PZH_LIVE_FANCY PASS output=${output.name} windows=0 empty-output`);
        continue;
    }

    const inner = {x: output.geometry.x + 12, y: output.geometry.y + 12,
        right: output.geometry.x + output.geometry.width - 12,
        bottom: output.geometry.y + output.geometry.height - 12};
    const rects = windows.map(window => {
        const rect = window.frameGeometry;
        return {id: String(window.internalId), x: rect.x, y: rect.y,
            right: rect.x + rect.width, bottom: rect.y + rect.height};
    });
    const errors = [];
    const tolerance = 2;
    rects.forEach(rect => {
        if (rect.x < inner.x - tolerance || rect.y < inner.y - tolerance ||
                rect.right > inner.right + tolerance ||
                rect.bottom > inner.bottom + tolerance) {
            errors.push(`out-of-bounds=${rect.id}:${rect.x},${rect.y}-${rect.right},${rect.bottom}`);
        }
    });
    for (let index = 0; index < 6; index++) {
        const zone = zoneRect(output, index);
        const centerX = (zone.x + zone.right) / 2;
        const centerY = (zone.y + zone.bottom) / 2;
        const covering = rects.filter(rect => centerX >= rect.x - tolerance &&
            centerX <= rect.right + tolerance &&
            centerY >= rect.y - tolerance &&
            centerY <= rect.bottom + tolerance).length;
        if (covering === 0) {
            errors.push(`empty-zone=${index + 1}`);
        }
    }

    if (errors.length === 0) {
        console.info(`PZH_LIVE_FANCY PASS output=${output.name} windows=${windows.length}`);
    } else {
        console.info(`PZH_LIVE_FANCY FAIL output=${output.name} windows=${windows.length} ${errors.join(";")}`);
    }
}
