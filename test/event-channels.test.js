const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// R9 (Wave 4): an event slot's NAME as a guide entry, for slots whose guide is empty or a
// placeholder. The names are the providers' own (test/fixtures/providers), with their time zones:
// a named zone as given, an unnamed one as North American Eastern with its daylight saving.
// The old code has no eventChannels module, and Sport never lists these games.
const { eventFromName, syntheticProgrammes } = require('../server/services/eventChannels');
const sportsEvents = require('../server/services/sportsEvents');

const NOW = Date.parse('2026-09-30T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
const parse = (name) => { const e = eventFromName(name, NOW); return e && [e.title, iso(e.start), iso(e.end)]; };

test('the four forms in the providers\' playlists, with their zones', () => {
    assert.deepEqual(parse('NEXT | BAHRAIN: RACE | Sun 04 Oct 01:50 EDT (US) | 8K EXCLUSIVE | US: APPLE TV F1 PPV 2'),
        ['F1: BAHRAIN: RACE', '2026-10-04T05:50', '2026-10-04T08:50'], 'EDT as named; the slot gives the league');
    assert.deepEqual(parse('NEXT | MEXICO: RACE | Sun 01 Nov 13:50 EST (US) | 8K EXCLUSIVE | US: APPLE TV F1 PPV 6'),
        ['F1: MEXICO: RACE', '2026-11-01T18:50', '2026-11-01T21:50'], 'EST as named');
    assert.deepEqual(parse('NHL: Pittsburgh vs Philadelphia @ Sep 30 7:30 PM :Sportsnet+  12'),
        ['NHL: Pittsburgh vs Philadelphia', '2026-09-30T23:30', '2026-10-01T02:30'], 'Eastern daylight time in September');
    assert.deepEqual(parse('Sportsnet Central Sep 29 @ Sep 30 5:00 AM :Sportsnet+  01')[0], 'Sportsnet Central', 'its own date is not the title');
    assert.deepEqual(parse('CA (TSN+ 019) | NCAA Football: North Texas vs. Tulsa (2026-10-01 21:00:00)'),
        ['NCAA Football: North Texas vs. Tulsa', '2026-10-02T01:00', '2026-10-02T04:00']);
    assert.equal(parse('CA (TSN+ 002) | ATP 500 Tennis: Tokyo _ Day #1 (Colosseum) (2026-09-29 22:00:05)')[0], 'ATP 500 Tennis: Tokyo · Day #1 (Colosseum)');
    assert.deepEqual(parse('NBA 02: Knicks (NYK) x Timberwolves (MIN) start:2025-01-18 00:20:00 stop:2025-01-18 04:20:00'),
        ['NBA 02: Knicks (NYK) x Timberwolves (MIN)', '2025-01-18T05:20', '2025-01-18T09:20'], 'Eastern standard time in January, its own end');
});

test('Eastern time follows daylight saving across the change (1 Nov 2026)', () => {
    assert.equal(iso(eventFromName('A v B (2026-10-31 20:00:00)', NOW).start), '2026-11-01T00:00');
    assert.equal(iso(eventFromName('A v B (2026-11-01 20:00:00)', NOW).start), '2026-11-02T01:00');
});

test('no date, no event: names with only a time, and ordinary channels, are left alone', () => {
    for (const name of ['Rugby 4: Australia vs Wales 5:30pm', 'NCAAF 01: NC State at Wake Forest 7:30pm', 'Fox Footy HD', 'NBA 06 :', 'US: NBA PASS PPV 3', '']) {
        assert.equal(eventFromName(name, NOW), null, name);
    }
});

test('every dated event-slot name in the three providers\' playlists parses to a title and a time', () => {
    let dated = 0;
    for (const f of ['strong8k', 'dream4k', 'trex']) {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, `fixtures/providers/${f}-xtream-raw.json`), 'utf8'));
        const items = Array.isArray(raw) ? raw : raw.live_streams || raw.streams || raw.channels || [];
        for (const { name } of items) {
            if (!/\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}|start:\d{4}-| @ [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} [AP]M|\| (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2} [A-Z][a-z]{2} \d{2}:\d{2}/.test(name || '')) continue;
            dated++;
            const ev = eventFromName(name, NOW);
            assert.ok(ev && ev.title && ev.end > ev.start, `parsed: ${name}`);
            assert.ok(!/\d{4}-\d{2}-\d{2}|@ [A-Z][a-z]{2} \d/.test(ev.title), `no date left in the title: ${ev.title}`);
        }
    }
    assert.ok(dated > 50, `the fixtures hold dated slot names (${dated})`);
});

test('the guide comes first: a slot\'s name is used only where its guide has nothing real at that time', () => {
    const from = Date.parse('2026-09-30T00:00:00Z');
    const to = from + 72 * 3600e3;
    const channels = [
        { key: '1:a', tvgId: 'sn12', name: 'NHL: Pittsburgh vs Philadelphia @ Sep 30 7:30 PM :Sportsnet+  12' },
        { key: '1:b', tvgId: 'sn13', name: 'MLB: AL Wildcard Boston vs New York Yankees Game 2 @ Sep 30 8:00 PM :Sportsnet+  13' },
        { key: '1:c', tvgId: null, name: 'CA (TSN+ 019) | NCAA Football: North Texas vs. Tulsa (2026-10-01 21:00:00)' },
        { key: '1:d', tvgId: 'fox', name: 'Fox Footy HD' }
    ];
    const progs = [
        { channel_id: 'sn12', title: '- NO EVENT STREAMING -', start_time: from, end_time: to },             // a placeholder: the name wins
        { channel_id: 'sn13', title: 'MLB Wildcard: Red Sox at Yankees', start_time: from + 20 * 3600e3, end_time: from + 30 * 3600e3 } // real: the guide wins
    ];
    const rows = syntheticProgrammes(channels, progs, from, to, from);
    assert.deepEqual(rows.map(r => [r.channel_id, r.title]), [
        ['sn12', 'NHL: Pittsburgh vs Philadelphia'],
        ['name:1:c', 'NCAA Football: North Texas vs. Tulsa']
    ]);
    assert.equal(channels[2].tvgId, 'name:1:c', 'a slot with no guide id gets one so the rows find it');

    // And Sport lists them as events on their slots.
    const events = sportsEvents.eventsFromProgrammes(channels.map((c, i) => ({ ...c, order: i, sportChannel: false, sourceId: 1, id: c.key })), [...progs, ...rows], []);
    const nhl = events.find(e => /Pittsburgh/.test(e.title));
    assert.ok(nhl, 'the NHL game is a Sport event');
    assert.equal(nhl.kind, 'event');
    assert.equal(nhl.start, Date.parse('2026-09-30T23:30:00Z'));
    assert.ok(events.some(e => /North Texas/.test(e.title)));
});

test('S4: slots sharing a placeholder guide id each list only their own game; a real shared guide id is still a simulcast', () => {
    const from = Date.parse('2026-10-01T00:00:00Z');
    const to = from + 72 * 3600e3;
    const channels = [
        { key: '1:a', tvgId: 'shared-placeholder', name: 'NHL: Pittsburgh vs Philadelphia @ Oct 1 7:30 PM :Sportsnet+ 12' },
        { key: '1:b', tvgId: 'shared-placeholder', name: 'NHL: Boston vs Toronto @ Oct 1 7:30 PM :Sportsnet+ 13' },
        { key: '1:c', tvgId: null, name: 'NHL: Calgary vs Edmonton @ Oct 1 9:00 PM :Sportsnet+ 14' },
        { key: '1:d', tvgId: 'fox.real', name: 'Fox League' },
        { key: '1:e', tvgId: 'fox.real', name: 'Fox League HD' }
    ];
    const progs = [{ channel_id: 'fox.real', title: 'NRL: Storm v Panthers', categories: '["Sport","NRL"]', start_time: from + 5 * 3600e3, end_time: from + 7 * 3600e3 }];
    const rows = syntheticProgrammes(channels, progs, from, to, from);
    const events = sportsEvents.eventsFromProgrammes(channels.map((c, i) => ({ ...c, order: i, sportChannel: true, sourceId: 1, id: c.key })),
        [...progs, ...rows], ['NHL', 'NRL']);
    const on = (re) => events.find(e => re.test(e.title)).channels.map(c => c.key).sort();
    assert.deepEqual(on(/Pittsburgh/), ['1:a'], 'not also on the Boston slot');
    assert.deepEqual(on(/Boston/), ['1:b']);
    assert.deepEqual(on(/Calgary/), ['1:c']);
    assert.deepEqual(on(/Storm/), ['1:d', '1:e'], 'a real guide listing on two channels is still one event on both');
});
