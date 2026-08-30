/* Live KWin invariant probe. Loaded by live-coverage.sh in Omarchy mode. */

function appId(window) {
    return String(window.desktopFileName || window.resourceClass ||
        window.resourceName || "").toLowerCase();
}

function candidate(window) {
    return Boolean(window && window.normalWindow && window.managed &&
        !window.minimized && !window.hidden && !window.deleted &&
        !window.skipTaskbar && !window.skipSwitcher &&
        !window.popupWindow && !window.dialog && !window.modal &&
        !window.transient && appId(window).indexOf("steam") < 0);
}

function uniqueSorted(values) {
    return Array.from(new Set(values.map(value => Math.round(value * 100) / 100)))
        .sort((a, b) => a - b);
}

function usableRect(output) {
    const screen = output.geometry;
    let left = screen.x;
    let top = screen.y;
    let right = screen.x + screen.width;
    let bottom = screen.y + screen.height;
    workspace.windowList().forEach(function (window) {
        if (!window.dock || window.output !== output || window.deleted) {
            return;
        }
        const rect = window.frameGeometry;
        const rectRight = rect.x + rect.width;
        const rectBottom = rect.y + rect.height;
        if (rect.y <= screen.y + 2) top = Math.max(top, rectBottom);
        if (rectBottom >= screen.y + screen.height - 2) bottom = Math.min(bottom, rect.y);
        if (rect.x <= screen.x + 2) left = Math.max(left, rectRight);
        if (rectRight >= screen.x + screen.width - 2) right = Math.min(right, rect.x);
    });
    if (right - left < 160 || bottom - top < 160) {
        return {x: screen.x + 12, y: screen.y + 12,
            right: screen.x + screen.width - 12,
            bottom: screen.y + screen.height - 12};
    }
    return {x: left + 12, y: top + 12,
        right: right - 12, bottom: bottom - 12};
}

for (const output of workspace.screenOrder) {
    const windows = workspace.windowList().filter(window =>
        candidate(window) && window.output === output);
    if (windows.length === 0) {
        console.info(`PZH_LIVE_COVERAGE PASS output=${output.name} windows=0 empty-output`);
        continue;
    }

    const inner = usableRect(output);
    const rects = windows.map(window => {
        const rect = window.frameGeometry;
        return {id: String(window.internalId), x: rect.x, y: rect.y,
            right: rect.x + rect.width, bottom: rect.y + rect.height};
    });
    const errors = [];
    const tolerance = 2;
    const minX = Math.min(...rects.map(rect => rect.x));
    const minY = Math.min(...rects.map(rect => rect.y));
    const maxX = Math.max(...rects.map(rect => rect.right));
    const maxY = Math.max(...rects.map(rect => rect.bottom));
    if (Math.abs(minX - inner.x) > tolerance ||
            Math.abs(minY - inner.y) > tolerance ||
            Math.abs(maxX - inner.right) > tolerance ||
            Math.abs(maxY - inner.bottom) > tolerance) {
        errors.push(`bounds=${minX},${minY}-${maxX},${maxY} expected=${inner.x},${inner.y}-${inner.right},${inner.bottom}`);
    }

    const xValues = [inner.x, inner.right];
    const yValues = [inner.y, inner.bottom];
    rects.forEach(function (rect) {
        xValues.push(Math.max(inner.x, rect.x));
        xValues.push(Math.min(inner.right, rect.right));
        yValues.push(Math.max(inner.y, rect.y));
        yValues.push(Math.min(inner.bottom, rect.bottom));
    });
    const xs = uniqueSorted(xValues);
    const ys = uniqueSorted(yValues);
    for (let xi = 0; xi < xs.length - 1; xi++) {
        for (let yi = 0; yi < ys.length - 1; yi++) {
            const width = xs[xi + 1] - xs[xi];
            const height = ys[yi + 1] - ys[yi];
            if (width <= 0 || height <= 0) {
                continue;
            }
            const x = xs[xi] + width / 2;
            const y = ys[yi] + height / 2;
            const covering = rects.filter(rect => x >= rect.x &&
                x < rect.right && y >= rect.y && y < rect.bottom).length;
            if (covering === 0 && width > 9 && height > 9) {
                errors.push(`hole=${xs[xi]},${ys[yi]} ${width}x${height}`);
            } else if (covering > 1) {
                errors.push(`overlap=${xs[xi]},${ys[yi]} ${width}x${height} count=${covering}`);
            }
        }
    }

    if (errors.length === 0) {
        console.info(`PZH_LIVE_COVERAGE PASS output=${output.name} windows=${windows.length}`);
    } else {
        console.info(`PZH_LIVE_COVERAGE FAIL output=${output.name} windows=${windows.length} ${errors.join(";")}`);
    }
}
