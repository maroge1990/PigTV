'use strict';
// #347: a finished game's card plays its recording, found by `recordings[].gameId` = the card's id (D-68). A league page's
// fixture whose front-page card has aged out, an F1 session and a cricket match have no C-R card of their own on their
// pages (`fx:`, `f1s:`, `ck:` ids), so a recording made from Sport was not found from them, and the F1 and cricket pages
// scheduled with no gameId. Each now carries the server's `card` (the C-R card id of the same game, C-P/C-Q/C-S/C-T): it is
// sent as gameId when recording, and the finished item's recording is found by it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser, answer, NOW, page, root } = require('./helpers/sportWeb');

const H = 3600000, D = 86400000;
const golden = (f) => JSON.parse(fs.readFileSync(path.join(root, 'test/golden', f), 'utf8'));
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

/** The Sports page on `route` with `pageUrl` answering `data`; `recordings` the GET /recordings rows. */
async function harness(route, pageUrl, data, features, recordings) {
    const sent = [], played = [];
    const b = browser({ request: async (m, url) => (url === '/sports/front' ? answer() : url === '/sports/pages/preferences' ? { spoilerFree: false }
        : url === '/info' ? { features } : url === pageUrl ? data : url === '/recordings' ? recordings : {}),
    recordings: { schedule: async (d) => { sent.push(JSON.parse(JSON.stringify(d))); return {}; } } });
    const app = { setLocation() {}, navigateTo() {}, pages: { recordings: { play: async (id) => { played.push(id); } } } };
    const p = page(b, app);
    await p.show(route);
    await settle();
    return { p, sent, played, press: (id) => p.select(id, null) };
}
const done = (id, gameId, extra = {}) => ({ id, gameId, status: 'completed', is_partial: 0, duration_sec: 7000, started_at: 1, ...extra });

test('a league page fixture whose front card aged out: its press plays the recording made from that card; Record sends its card', async () => {
    const data = golden('sports-page-league-afl.json');
    const fin = data.rounds[1].games[0]; // the Grand Final, done, card espn:australian-football/afl:1133711 (the golden's)
    assert.deepEqual([fin.status, fin.card], ['done', 'espn:australian-football/afl:1133711']);
    const next = { ...fin, id: '1133799', status: 'scheduled', detail: null, start: NOW + 2 * H, card: 'espn:australian-football/afl:1133799',
        channels: [{ sourceId: 2, stableId: 'k', id: '77', name: 'Fox Footy', start: NOW + 2 * H - 600000, end: NOW + 5 * H }] };
    data.rounds[1].games.push(next);
    const h = await harness('Australian%20football/AFL', '/sports/pages/league/AFL', data, { sportPageLeagues: ['AFL'] },
        [done(4, 'espn:australian-football/afl:1133710'), done(5, 'espn:australian-football/afl:1133711')]);
    assert.ok(!answer().games.some(g => g.id === fin.card), 'the front page has no card for the game');
    await h.press(`fx:AFL:${fin.id}`);
    assert.deepEqual(h.played, [5], 'the recording whose gameId is the fixture\'s card');
    await h.p.record(`fx:AFL:${next.id}`);
    assert.deepEqual(h.sent.map(s => s.gameId), ['espn:australian-football/afl:1133799']);
});

test('an F1 session: a finished one plays its recording; Record sends the session\'s card as gameId', async () => {
    const p = golden('sports-page-f1.json');
    p.weekend.sessions = [
        { id: 'qualifying', name: 'Qualifying', start: NOW - 3 * H, end: NOW - 2 * H, status: 'done', top: { kind: 'pole', driver: 'Kimi Antonelli' }, channels: [], card: 'espn:racing/f1:401839127' },
        { id: 'race', name: 'Race', start: NOW + D, end: NOW + D + 2 * H, status: 'scheduled', top: null, card: 'espn:racing/f1:401839128',
            channels: [{ sourceId: 1, stableId: 'f', id: '506', name: 'Fox Sports 506', start: NOW + D - 600000, end: NOW + D + 2 * H }] }];
    const h = await harness('Motorsport/F1', '/sports/pages/f1', p, { sportPages: true },
        [done(8, 'espn:racing/f1:401839126'), done(9, 'espn:racing/f1:401839127'), done(10, null, { title: 'Qualifying' })]);
    await h.press('f1s:qualifying');
    assert.deepEqual(h.played, [9]);
    await h.p.record('f1s:race');
    assert.deepEqual(h.sent.map(s => s.gameId), ['espn:racing/f1:401839128']);
});

test('a cricket match: a finished one plays its recording; Record sends the match\'s card as gameId', async () => {
    const p = golden('sports-page-cricket.json');
    const other = p.others[0];
    other.status = 'done'; other.card = 'espn:cricket/24756:1553295';
    p.lead.status = 'scheduled'; p.lead.start = NOW + 2 * H; p.lead.nextStart = NOW + 2 * H; p.lead.card = 'espn:cricket/24203:1525661';
    p.lead.channels = [{ sourceId: 1, stableId: 'c', id: '501', name: 'Fox Cricket', start: NOW + 2 * H - 600000, end: NOW + 9 * H }];
    const h = await harness('Cricket/Cricket', '/sports/pages/cricket', p, { sportPageCricket: true },
        [done(11, 'espn:cricket/24756:1553295'), done(12, 'espn:cricket/24203:1525661', { status: 'failed' })]);
    await h.press(`ck:${other.id}`);
    assert.deepEqual(h.played, [11]);
    await h.p.record(`ck:${p.lead.id}`);
    assert.deepEqual(h.sent.map(s => s.gameId), ['espn:cricket/24203:1525661']);
});

test('an item without a card (an older server) records with no gameId and plays nothing on a press', async () => {
    const p = golden('sports-page-f1.json');
    p.weekend.sessions = [
        { id: 'qualifying', name: 'Qualifying', start: NOW - 3 * H, end: NOW - 2 * H, status: 'done', top: null, channels: [] },
        { id: 'race', name: 'Race', start: NOW + D, end: NOW + D + 2 * H, status: 'scheduled', top: null,
            channels: [{ sourceId: 1, stableId: 'f', id: '506', name: 'Fox Sports 506', start: NOW + D - 600000, end: NOW + D + 2 * H }] }];
    const h = await harness('Motorsport/F1', '/sports/pages/f1', p, { sportPages: true }, [done(9, 'espn:racing/f1:401839127')]);
    await h.press('f1s:qualifying');
    assert.deepEqual(h.played, []);
    await h.p.record('f1s:race');
    assert.equal(h.sent.length, 1);
    assert.ok(!('gameId' in h.sent[0]));
});

test('a fixture with a `card` whose front card is gone is never joined to another game\'s card by names and time (Codex, medium)', () => {
    const { V } = browser();
    const front = answer(); // its EPL card "ars": Arsenal v Chelsea, started an hour ago
    const ars = front.games.find(g => g.id === 'ars');
    const fx = { start: ars.start + 30 * 60000, home: { name: 'Arsenal', abbr: 'ARS' }, away: { name: 'Chelsea', abbr: 'CHE' } };
    assert.equal(V.fixtureCard({ ...fx, card: 'espn:soccer/eng.1:555' }, 'EPL', front), null, 'its own card is absent: none');
    assert.equal(V.fixtureCard({ ...fx, card: 'ars' }, 'EPL', front).id, 'ars', 'its own card');
    assert.equal(V.fixtureCard(fx, 'EPL', front).id, 'ars', 'no card (an older server): the names and time join');
});

// Codex (high): a cancel made on the front card was held under the card's id; Record from the sport page settled cancels
// under its own `f1s:` id, so the new schedule came back as the one about to be cancelled, and the cancel then removed it.
test('cancel an F1 recording on its front card, Record it again from the F1 page during the Undo: the cancel goes first', async () => {
    const calls = [];
    const air = { sourceId: 1, stableId: 'f', id: '506', name: 'Fox Sports 506', start: NOW + D - 600000, end: NOW + D + 2 * H };
    const front = answer();
    Object.assign(front.games.find(g => g.id === 'f1'), { channels: [air], recording: { scheduleId: 4, status: 'scheduled', ruleId: null } });
    const f1 = golden('sports-page-f1.json');
    f1.weekend.sessions = [{ id: 'race', name: 'Race', start: NOW + D, end: NOW + D + 2 * H, status: 'scheduled', top: null, card: 'f1', channels: [air] }];
    let deleted = false;
    const b = browser({ request: async (m, url) => {
        calls.push([m, url]);
        if (m === 'DELETE') { deleted = true; return {}; }
        if (url === '/recordings/scheduled') return deleted ? [] : [{ id: 4, status: 'scheduled', pre_buffer_min: 2, post_buffer_min: 15, source_id: 1, channel_item_id: '506', channel_stable_id: 'f', channel_name: 'Fox Sports 506' }];
        return url === '/sports/front' ? JSON.parse(JSON.stringify(front)) : url === '/sports/pages/preferences' ? { spoilerFree: false }
            : url === '/info' ? { features: { sportPages: true } } : url === '/sports/pages/f1' ? f1 : {};
    }, recordings: { schedule: async (d) => { calls.push(['schedule', d.gameId]); return { id: 5 }; } } });
    const p = page(b, { setLocation() {}, navigateTo() {} });
    await p.show('');
    p.openRecord('f1');
    await settle(); await settle();
    b.document.body.querySelector('dialog [data-act="r-cancel"]').click();
    await p.show('Motorsport/F1');
    await settle();
    await p.record('f1s:race');
    await settle();
    assert.deepEqual(calls.filter(c => c[0] === 'DELETE' || c[0] === 'schedule'), [['DELETE', '/recordings/scheduled/4'], ['schedule', 'f1']]);
});

// Codex (medium): a finished cricket lead and the finished matches of its tour had no way to their recording.
test('cricket: a finished lead\'s Play recording and a finished tour match\'s row play their recordings (a Test: its longest day)', async () => {
    const p = golden('sports-page-cricket.json');
    p.lead.status = 'done'; p.lead.channels = [];
    p.series.matches.find(m => m.id === p.lead.id).status = 'done';
    const rows = [done(21, 'espn:cricket/24203:1525655'), done(22, 'espn:cricket/24203:1525661', { duration_sec: 25000, started_at: 2 }),
        done(23, 'espn:cricket/24203:1525661', { duration_sec: 26000, started_at: 3 })];
    const h = await harness('Cricket/Cricket', '/sports/pages/cricket', p, { sportPageCricket: true }, rows);
    const html = h.p.root.innerHTML;
    const lead = h.p.root.querySelector('[data-key="lead:recording"]');
    assert.ok(lead, 'the finished lead has Play recording');
    assert.match(html, /data-act="game" data-id="ck:1525661" data-key="lead:recording">[\s\S]*?Play recording<\/button>/);
    lead.click();
    await settle();
    assert.deepEqual(h.played, [23], 'the lead\'s recording: its longest whole day');
    const row = h.p.root.querySelector('[data-key="sm:1525655"]');
    assert.ok(row, 'a finished match of the tour is pressable');
    assert.equal(row.getAttribute('data-act'), 'game');
    row.click();
    await settle();
    assert.deepEqual(h.played, [23, 21]);
});
