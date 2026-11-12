const { test } = require('node:test');
const assert = require('node:assert/strict');

// D-7 (#274): the walk a viewer's start takes through a channel's providers has one owner,
// services/playbackStart.js, used by the play route's first pass and the relay's cold start.
// A fake coordinator records every call, so the order of the walk is pinned here.
const { startOnFirstFree, SKIP, STOP } = require('../server/services/playbackStart');

function fakeCoordinator({ busy = [], refused = [], admitThrows = null, canAdmitThrows = null } = {}) {
    const calls = [];
    let n = 0;
    const live = new Set();
    return {
        calls,
        live,
        canAdmitWithoutDisturbing(ask) {
            calls.push(`canAdmit ${ask.providerId}`);
            if (canAdmitThrows === ask.providerId) throw new Error('recordings could not be read');
            return !busy.includes(ask.providerId);
        },
        async admitViewer(ask) {
            calls.push(`admit ${ask.providerId}`);
            if (admitThrows === ask.providerId) throw new Error('recordings could not be read');
            if (refused.includes(ask.providerId)) return { allowed: false };
            const lease = { id: `L${++n}`, providerId: ask.providerId, sessionId: null };
            live.add(lease.id);
            return { allowed: true, lease, release: [] };
        },
        releaseUnbound(lease) {
            calls.push(`release ${lease && lease.id}`);
            if (lease && !lease.sessionId) live.delete(lease.id);
        }
    };
}
const cands = (...ids) => ids.map(id => ({ providerId: id }));
const askFor = (c) => ({ force: false, providerId: c.providerId });

test('the first candidate that can be admitted without disturbing anybody is started; the walk stops there', async () => {
    const coord = fakeCoordinator({ busy: ['A'] });
    const started = [];
    const result = await startOnFirstFree(cands('A', 'B', 'C'), {
        coordinator: coord, ask: askFor,
        start: async (c, i, lease) => { started.push(c.providerId); lease.sessionId = 's1'; return { on: c.providerId, i }; }
    });
    assert.deepEqual(result, { on: 'B', i: 1 });
    assert.deepEqual(started, ['B']);
    assert.deepEqual(coord.calls, ['canAdmit A', 'canAdmit B', 'admit B', 'release L1']);
    assert.equal(coord.live.size, 1, 'the bound lease is kept');
});

test('a candidate admitViewer refuses is passed over without a start or a release', async () => {
    const coord = fakeCoordinator({ refused: ['A'] });
    const result = await startOnFirstFree(cands('A', 'B'), {
        coordinator: coord, ask: askFor, start: async (c) => c.providerId
    });
    assert.equal(result, 'B');
    assert.deepEqual(coord.calls, ['canAdmit A', 'admit A', 'canAdmit B', 'admit B', 'release L1']);
});

test('an unbound lease is released exactly once after a failed start and once after a successful one', async () => {
    const coord = fakeCoordinator();
    const failures = [];
    const result = await startOnFirstFree(cands('A', 'B'), {
        coordinator: coord, ask: askFor,
        start: async (c) => { if (c.providerId === 'A') throw new Error('502'); return 'ok'; },
        failed: (err, c, i) => failures.push(`${c.providerId}#${i}: ${err.message}`)
    });
    assert.equal(result, 'ok');
    assert.deepEqual(failures, ['A#0: 502']);
    assert.deepEqual(coord.calls, ['canAdmit A', 'admit A', 'release L1', 'canAdmit B', 'admit B', 'release L2']);
    assert.equal(coord.live.size, 0, 'neither start bound its lease: both given back');
});

test('the failed hook runs before the lease is released (the route logs, then releases)', async () => {
    const coord = fakeCoordinator();
    await startOnFirstFree(cands('A'), {
        coordinator: coord, ask: askFor,
        start: async () => { throw new Error('502'); },
        failed: () => coord.calls.push('failed')
    });
    assert.deepEqual(coord.calls, ['canAdmit A', 'admit A', 'failed', 'release L1']);
});

test('a falsy start result goes on to the next candidate (the relay\'s leg that could not be used)', async () => {
    const coord = fakeCoordinator();
    const result = await startOnFirstFree(cands('A', 'B', 'C'), {
        coordinator: coord, ask: askFor, start: async (c) => (c.providerId === 'C' ? 'leg' : null)
    });
    assert.equal(result, 'leg');
    assert.deepEqual(coord.calls.filter(c => c.startsWith('release')), ['release L1', 'release L2', 'release L3']);
});

test('none can be started: null, and every lease given back', async () => {
    const coord = fakeCoordinator({ busy: ['B'] });
    const result = await startOnFirstFree(cands('A', 'B'), { coordinator: coord, ask: askFor, start: async () => null });
    assert.equal(result, null);
    assert.equal(coord.live.size, 0);
});

test('a before hook that says STOP ends the walk without admitting; SKIP passes the candidate over', async () => {
    const coord = fakeCoordinator();
    const seen = [];
    const result = await startOnFirstFree(cands('A', 'B', 'C'), {
        coordinator: coord, ask: (c) => { seen.push(`ask ${c.providerId}`); return askFor(c); },
        before: (c, i) => { seen.push(`before ${c.providerId}#${i}`); return c.providerId === 'A' ? SKIP : STOP; },
        start: async () => 'never'
    });
    assert.equal(result, null);
    assert.deepEqual(seen, ['before A#0', 'before B#1']);
    assert.deepEqual(coord.calls, []);
});

test('a before hook that throws propagates before any admission', async () => {
    const coord = fakeCoordinator();
    await assert.rejects(startOnFirstFree(cands('A'), {
        coordinator: coord, ask: askFor, before: () => { throw new Error('superseded'); }, start: async () => 'never'
    }), /superseded/);
    assert.deepEqual(coord.calls, []);
});

test('a failed hook that rethrows propagates, and the lease is still released', async () => {
    const coord = fakeCoordinator();
    await assert.rejects(startOnFirstFree(cands('A', 'B'), {
        coordinator: coord, ask: askFor,
        start: async () => { throw new Error('not the provider'); },
        failed: (err) => { throw err; }
    }), /not the provider/);
    assert.deepEqual(coord.calls, ['canAdmit A', 'admit A', 'release L1']);
    assert.equal(coord.live.size, 0);
});

test('without a failed hook a start that throws propagates, and the lease is still released', async () => {
    const coord = fakeCoordinator();
    await assert.rejects(startOnFirstFree(cands('A', 'B'), {
        coordinator: coord, ask: askFor, start: async () => { throw new Error('boom'); }
    }), /boom/);
    assert.deepEqual(coord.calls, ['canAdmit A', 'admit A', 'release L1']);
});

test('the admitted hook sees the verdict before the start', async () => {
    const coord = fakeCoordinator();
    const order = [];
    await startOnFirstFree(cands('A'), {
        coordinator: coord, ask: askFor,
        admitted: (verdict, c) => order.push(`admitted ${c.providerId} ${verdict.lease.id}`),
        start: async (c, i, lease, verdict) => { order.push(`start ${lease.id} ${verdict.allowed}`); return 1; }
    });
    assert.deepEqual(order, ['admitted A L1', 'start L1 true']);
});

test('a recordings source that fails (canAdmit or admitViewer throws) propagates with no lease taken', async () => {
    for (const where of ['canAdmitThrows', 'admitThrows']) {
        const coord = fakeCoordinator({ [where]: 'B' });
        await assert.rejects(startOnFirstFree(cands('B', 'C'), {
            coordinator: coord, ask: askFor, start: async () => 'never'
        }), /recordings could not be read/);
        assert.equal(coord.live.size, 0, where);
        assert.ok(!coord.calls.some(c => c.startsWith('release')), where);
        assert.ok(!coord.calls.includes('canAdmit C'), `${where}: the walk ends`);
    }
});

test('with admissionFailed, that failure ends the walk with null after the hook (the relay logs it)', async () => {
    const coord = fakeCoordinator({ admitThrows: 'A' });
    const seen = [];
    const result = await startOnFirstFree(cands('A', 'B'), {
        coordinator: coord, ask: askFor, start: async () => 'never',
        admissionFailed: (err, c) => seen.push(`${c.providerId}: ${err.message}`)
    });
    assert.equal(result, null);
    assert.deepEqual(seen, ['A: recordings could not be read']);
    assert.deepEqual(coord.calls, ['canAdmit A', 'admit A']);
});
