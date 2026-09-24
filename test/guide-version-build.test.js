const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 0140: the guide version carries the build, so a deploy that changes row shape
// or order (as 0139 did) makes cached guides reload once.
test('the guide version includes the server build', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'libraryRev.js'), 'utf8');
    assert.match(src, /return `\$\{build\}:\$\{rev\}:\$\{gens\}`/);
});
