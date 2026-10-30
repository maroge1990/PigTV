process.env.PIGTV_DB_BACKUPS = '0';
const root = process.argv[2]; require(root + '/server/db/sqlite').getDb();
const ev = require(root + '/server/services/sportsEvents');
const base = ['AFL','F1','EPL','Cricket','MLB','NFL','FA Cup','UEFA','Championship','NBA'];
for (const follow of [base, [...base, 'EFL Cup', 'Carabao Cup'], ['EFL Cup', 'Carabao Cup', ...base]]) {
  const { events } = ev.buildEvents({ from: Date.parse('2026-10-28T18:00:00Z'), follow });
  const e = events.filter(x => /Man City v Brighton|Fleetwood|Brighton/i.test(x.title + (x.aliases||[]).join(' ')) && x.start < Date.parse('2026-10-29T00:00Z'));
  console.log(JSON.stringify(follow.slice(-3)), '=>', e.map(x => `${x.kind} ${x.league} "${x.title}" (${x.kindRule})`).join(' ; ') || 'not listed');
}
