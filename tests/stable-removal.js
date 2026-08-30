#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const controller = fs.readFileSync(path.join(root,
    "kwin/plasmazones-omarchy-lock/contents/code/main.js"), "utf8");

const signal = {connect: function () {}};
const workspace = {
    activeWindow: null,
    currentDesktop: {x11DesktopNumber: 1},
    desktops: [],
    screenOrder: [],
    windowList: function () { return []; },
    createDesktop: function (index, name) {
        this.desktops.splice(index, 0,
            {x11DesktopNumber: index + 1, name: name});
    },
    windowAdded: signal,
    currentDesktopChanged: signal,
    screensChanged: signal,
    screenOrderChanged: signal
};

const assertions = String.raw`
function testWindow(name, order) {
    const window = {name: name, frameGeometry: {
        x: 0, y: 0, width: 100, height: 100
    }};
    openedOrder.set(window, order);
    return window;
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

const closed = testWindow("closed-top", 1);
const newerBottom = testWindow("newer-bottom", 3);
const olderBottom = testWindow("older-bottom", 2);
let tree = {window: null, orientation: "h", ratio: 0.5,
    first: leaf(closed),
    second: {window: null, orientation: "v", ratio: 0.5,
        first: leaf(newerBottom), second: leaf(olderBottom)}};

tree = removeWindowPreservingShape(tree, closed);
assert(!isLeaf(tree), "the vacated parent split must survive");
assert(tree.orientation === "h", "the vacated split orientation must survive");
assert(tree.first.window === olderBottom,
    "the oldest sibling leaf must occupy the vacated tile");
assert(tree.second.window === newerBottom,
    "the remaining sibling must fill only its former subtree");

const onlySibling = testWindow("only-sibling", 4);
tree = {window: null, orientation: "v", ratio: 0.5,
    first: leaf(closed), second: leaf(onlySibling)};
tree = removeWindowPreservingShape(tree, closed);
assert(isLeaf(tree) && tree.window === onlySibling,
    "a two-leaf parent must collapse normally");

const conventionalOld = testWindow("conventional-old", 5);
const conventionalNew = testWindow("conventional-new", 6);
tree = {window: null, orientation: "h", ratio: 0.5,
    first: leaf(closed),
    second: {window: null, orientation: "v", ratio: 0.5,
        first: leaf(conventionalOld), second: leaf(conventionalNew)}};
tree = removeWindowFromTree(tree, closed);
assert(tree.orientation === "v" && tree.first.window === conventionalOld,
    "structural removal must retain conventional BSP collapse");

const leftOutput = {name: "left", geometry: {
    x: -1920, y: 200, width: 1920, height: 1080
}};
const centerOutput = {name: "center", geometry: {
    x: 0, y: 0, width: 2560, height: 1440
}};
const rightOutput = {name: "right", geometry: {
    x: 2560, y: 0, width: 1707, height: 960
}};
const upperOutput = {name: "upper", geometry: {
    x: 0, y: -1080, width: 1920, height: 1080
}};
workspace.screenOrder = [rightOutput, upperOutput, leftOutput, centerOutput];
screenIdsByConnector.set("left", "screen-left");
screenIdsByConnector.set("center", "screen-center");
screenIdsByConnector.set("right", "screen-right");
screenIdsByConnector.set("upper", "screen-upper");
assert(directionalOutput(centerOutput, "left") === leftOutput,
    "left must use physical output geometry, not screen-list order");
assert(directionalOutput(centerOutput, "right") === rightOutput,
    "right must support mixed-size and mixed-DPI logical geometries");
assert(directionalOutput(centerOutput, "up") === upperOutput,
    "up must select the physically upper output");
assert(directionalOutput(centerOutput, "down") === null,
    "a missing directional output must be a no-op");
assert(outputForContextKey(contextKey("screen-right", 3)) === rightOutput,
    "late geometry updates must resolve the tree's intended output");

const swapA = testWindow("swap-a", 7);
const swapB = testWindow("swap-b", 8);
const swapC = testWindow("swap-c", 9);
tree = {window: null, orientation: "v", ratio: 0.6,
    first: leaf(swapA),
    second: {window: null, orientation: "h", ratio: 0.4,
        first: leaf(swapB), second: leaf(swapC)}};
const swapRoot = tree;
const swapBranch = tree.second;
const leaves = [];
collectLeaves(tree, leaves);
const leafA = leaves.find(candidate => candidate.window === swapA);
const leafC = leaves.find(candidate => candidate.window === swapC);
leafA.window = swapC;
leafC.window = swapA;
assert(tree === swapRoot && tree.second === swapBranch,
    "pane swapping must retain every tree node");
assert(tree.orientation === "v" && tree.ratio === 0.6 &&
        tree.second.orientation === "h" && tree.second.ratio === 0.4,
    "pane swapping must retain orientations and ratios");
assert(tree.first.window === swapC && tree.second.second.window === swapA,
    "pane swapping must exchange only leaf occupants");
assert(!isUsableGeometry(undefined) &&
        !isUsableGeometry({x: 0, y: 0, width: 0, height: 100}) &&
        isUsableGeometry({x: 0, y: 0, width: 100, height: 100}),
    "screen transfer must reject transient or empty frame geometries");

console.log("Stable removal tests passed.");
`;

vm.runInNewContext(controller + "\n" + assertions, {
    workspace: workspace,
    registerShortcut: function () {},
    callDBus: function () {},
    console: console,
    Map: Map,
    Set: Set,
    Array: Array,
    Number: Number,
    Math: Math,
    String: String,
    Boolean: Boolean
}, {filename: "main.js"});
