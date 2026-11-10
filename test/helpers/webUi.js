const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// public/js/ui.js (window.UI: the one escape, time format and debounce) is a plain global the pages load right after
// api.js. A test that runs another public/js file in a vm context loads it into that context first, through here.
const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/ui.js'), 'utf8');

/** Load ui.js into a vm context (once: a second call does nothing). Returns the context. */
function loadUi(context) {
    if (vm.runInContext('typeof UI', context) === 'undefined') vm.runInContext(SOURCE, context);
    return context;
}

/** For tests that `require()` a public/js file in Node itself: make UI a Node global. */
function globalUi() {
    global.UI = require('../../public/js/ui.js');
    return global.UI;
}

module.exports = { loadUi, globalUi };
