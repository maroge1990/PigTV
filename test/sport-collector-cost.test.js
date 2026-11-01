const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// #29: the score collector's cost on the event loop, tick by tick (sportCollectorCost.js), for the Status page and the
// measurement before the sport revamp is deployed. Timing and sizes only. The old code counts nothing.
const dashboard = require('../server/services/sportsDashboard');
const espn = require('../server/services/sportsScoresEspn');
const cost = require('../server/services/sportCollectorCost');
const { createStore } = require('../server/services/sportsDashboardStore');
const NOW = Date.parse('2026-11-01T06:00Z');
const databases = [];
after(() => databases.forEach(db => db.close()));

test('#29: a collector tick counts its answers, bytes, parse, normalise and ingest time, and nothing else', async () => {
    cost.reset();
    const body = fs.readFileSync(path.join(__dirname, 'fixtures/espn-individual/tennis-atp-2026-11-01.json'));
    const real = global.fetch;
    global.fetch = async () => new Response(body, { status: 200 });
    try {
        const db = new Database(':memory:'); databases.push(db);
        const c = dashboard.createCollector({ store: createStore(db), fetchJson: espn.fetchJson, clock: () => NOW, enabled: () => true,
            leagues: () => new Set(['ATP Tour', 'Grand Slams']), feedGames: async () => ({ ok: true, games: [] }) });
        await c.refresh(); c.stop();
    } finally { global.fetch = real; }
    const s = cost.summary();
    assert.equal(s.ticks, 1);
    assert.equal(s.last.requests, 1, 'one answer, shared by two leagues');
    assert.equal(s.last.bytes, body.length);
    for (const f of ['parseMs', 'maxParseMs', 'normalizeMs', 'ingestMs', 'busyMs', 'tickMs']) assert.ok(Number.isFinite(s.last[f]) && s.last[f] >= 0, f);
    assert.ok(s.last.busyMs >= s.last.maxParseMs);
    assert.deepEqual(Object.keys(s), ['ticks', 'last', 'p95', 'max']);
    assert.ok(!/http|espn|tennis|atp/i.test(JSON.stringify(s)), 'never a URL, league or payload');
});

test('#29: the summary keeps the last hour of ticks, with each figure\'s 95th percentile and worst', () => {
    cost.reset();
    for (let i = 1; i <= cost.WINDOW + 20; i++) { const t = cost.tick(); cost.parsed(t, i * 1000, i); cost.record(t); }
    const s = cost.summary();
    assert.equal(s.ticks, cost.WINDOW);
    assert.equal(s.max.maxParseMs, cost.WINDOW + 20);
    assert.equal(s.last.bytes, (cost.WINDOW + 20) * 1000);
    assert.equal(s.p95.parseMs, 134, 'ticks 21..140: the 95th percentile is 134');
});
