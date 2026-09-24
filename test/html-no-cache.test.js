const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 0125: after a redeploy the browser must revalidate the page, or it keeps
// running the previous build's scripts until a hard reload.
test('index.html is served with Cache-Control: no-cache', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.match(src, /setHeaders: noCacheHtml/);
    assert.match(src, /res\.set\('Cache-Control', 'no-cache'\);\s*\n\s*res\.sendFile\(path\.join\(__dirname, '\.\.', 'public', 'index\.html'\)\)/);
});
