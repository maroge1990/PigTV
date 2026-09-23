const { test } = require('node:test');
const assert = require('node:assert/strict');

// 0107: server/routes/proxy.js registered GET /epg/:sourceId twice (~line 327
// and ~line 546) and DELETE /cache/:sourceId twice (~line 422 and ~line 589).
// Express only ever runs the FIRST matching layer, so the second of each pair
// was dead code - unreachable, but still there to be misread or edited by
// mistake. This asserts each path+method combination is registered exactly
// once in the router's own stack, so a reintroduced duplicate fails loudly
// instead of silently doing nothing.
const router = require('../server/routes/proxy');

function countLayers(method, routePath) {
    return router.stack.filter(l => l.route && l.route.path === routePath && l.route.methods[method]).length;
}

test('GET /epg/:sourceId is registered exactly once', () => {
    assert.equal(countLayers('get', '/epg/:sourceId'), 1, 'a second registration would be unreachable dead code');
});

test('DELETE /cache/:sourceId is registered exactly once', () => {
    assert.equal(countLayers('delete', '/cache/:sourceId'), 1, 'a second registration would be unreachable dead code');
});
