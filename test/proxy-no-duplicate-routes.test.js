const { test } = require('node:test');
const assert = require('node:assert/strict');

// 0107 removed a dead second GET /epg/:sourceId and DELETE /cache/:sourceId from
// server/routes/proxy.js; 0122 removed the rest of the fork's proxy routes (the
// Xtream emulation, the whole-EPG dump, /m3u, /cache, /image) once the web app had
// moved onto /api/library. What is left is one route, registered once.
const router = require('../server/routes/proxy');

test('the proxy router registers GET /stream, exactly once, and nothing else', () => {
    const routes = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
    assert.deepEqual(routes, ['GET /stream']);
});
