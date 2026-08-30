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
