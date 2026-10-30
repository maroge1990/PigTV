// Offline replay of the Sports build on rows exported read-only from production (no URLs).
// node replay.js <server copy root> <from ISO>...  - runs inside the copy's own data/ folder.
process.env.PIGTV_DB_BACKUPS = '0';
const root = process.argv[2], froms = process.argv.slice(3);
const zlib = require('zlib'), fs = require('fs');
const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + '/prod-sports.json.gz')));
const sqlite = require(root + '/server/db/sqlite');
const db = sqlite.getDb();
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('app_data_migrated', ?)").run('x');
const cols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
function put(table, rows) {
    if (!rows.length) return;
    const c = cols(table);
    const ks = Object.keys(rows[0]).filter(k => c.has(k));
    const st = db.prepare(`INSERT OR REPLACE INTO ${table} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`);
    db.transaction(() => { for (const r of rows) st.run(...ks.map(k => r[k])); })();
}
if (!db.prepare('SELECT COUNT(*) n FROM playlist_items').get().n) {
    put('playlist_items', j.channels.map((r, i) => ({ ...r, id: i + 1, type: 'live', is_hidden: 0, data: '{}' })));
    put('epg_mappings', j.mappings.map(m => ({ ...m, updated_at: m.updated_at ?? Date.now() })));
    put('sport_categories', j.sportCategories);
    put('epg_programs', j.programmes.map(p => ({ ...p, gen: 0 })));
    put('sports_follow', j.follow);
    put('sport_fixtures', j.fixtures);
    put('sport_fixture_teams', j.teams);
    put('sport_fixture_status', j.status);
}
const ev = require(root + '/server/services/sportsEvents');
const RE = new RegExp(process.env.PICK || 'south africa|rsa v aus|fleetwood|brewers|rays|mlb|world series', 'i');
for (const f of froms) {
    const from = Date.parse(f);
    ev.reset?.();
    const { events, channelCount, programmeCount } = ev.buildEvents({ from });
    const byLeague = {};
    for (const e of events) if (e.kind === 'event') byLeague[e.league] = (byLeague[e.league] || 0) + 1;
    console.log(`=== from ${f}: channels ${channelCount}, programmes ${programmeCount}, items ${events.length}; events by league ${JSON.stringify(byLeague)}`);
    const pick = events.filter(e => RE.test(e.title + ' ' + (e.aliases || []).join(' ')) && e.start < from + (Number(process.env.HOURS) || 8) * 3600e3);
    for (const e of pick) {
        console.log([e.kind, e.live ? 'LIVE' : '-', e.league, new Date(e.start).toISOString().slice(5, 16),
            JSON.stringify(e.title), (e.kindRule || '').slice(0, 80), 'ch=' + e.channels.length,
            e.channels.slice(0, Number(process.env.CH) || 5).map(c => c.name).join(' | ')].join('  '));
    }
}
