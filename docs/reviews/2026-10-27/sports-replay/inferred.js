process.env.PIGTV_DB_BACKUPS = '0';
const root = process.argv[2];
require(root + '/server/db/sqlite').getDb();
const ev = require(root + '/server/services/sportsEvents'), c = require(root + '/server/services/sportsClassify');
const seen = new Map();
for (const f of ['2026-10-26T13:00:00Z', '2026-10-28T01:00:00Z']) {
  for (const e of ev.buildEvents({ from: Date.parse(f) }).events) {
    if (!['MLB', 'NFL', 'NBA', 'AFL', 'EPL', 'Championship', 'FA Cup', 'UEFA'].includes(e.league)) continue;
    const titles = [e.title, ...(e.aliases || [])];
    if (titles.some(t => c.detectLeague(t))) continue; // named its league somewhere
    seen.set(e.league + ' ' + e.title, `${e.kind} ${new Date(e.start).toISOString().slice(5,16)} ch=${e.channels.length} ${e.channels.slice(0,3).map(x=>x.name).join(' | ')} :: ${titles.slice(0,3).join(' || ')}`);
  }
}
for (const [k, v] of seen) console.log(k.padEnd(50), v.slice(0, 260));
console.log('roster-only items:', seen.size);
