// 0150: loads test/fixtures/sports-export.json (Mark's preview export titles) as the channels and
// epg_live rows that sportsEvents.eventsFromProgrammes() takes.
const fixture = require('../fixtures/sports-export.json');

const HOUR = 60 * 60 * 1000;
const at = (hhmm) => Date.parse(`${fixture.day}T${hhmm}:00${fixture.offset}`);

function loadExport() {
    const channels = [];
    const programmes = [];
    const add = (name, list) => {
        const tvgId = `ch${channels.length}`;
        channels.push({ key: `1:${tvgId}`, order: channels.length, tvgId, sportChannel: false, name, quality: null });
        for (const [title, start, end, categories] of list) {
            const s = at(start);
            let e = at(end);
            if (e <= s) e += 24 * HOUR;
            programmes.push({ channel_id: tvgId, title, start_time: s, end_time: e, categories: categories ? JSON.stringify(categories) : null });
        }
    };
    for (const ch of fixture.channels) {
        for (const n of ch.each || [null]) {
            const fill = (s) => (n === null ? s : s.replaceAll('{n}', String(n)));
            let list = ch.programmes || [];
            if (ch.blocks) {
                const { title, start, hours, count } = ch.blocks;
                list = Array.from({ length: count }, (_, i) => {
                    const s = new Date(at(start) + i * hours * HOUR);
                    const e = new Date(at(start) + (i + 1) * hours * HOUR);
                    const hm = (d) => d.toLocaleTimeString('en-GB', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: false });
                    return [fill(title), hm(s), hm(e)];
                });
            }
            add(fill(ch.name), list.map(([t, ...rest]) => [fill(t), ...rest]));
        }
    }
    return { channels, programmes, follow: fixture.follow, from: at(fixture.from) };
}

module.exports = { loadExport };
