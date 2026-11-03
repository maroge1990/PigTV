#!/usr/bin/env node
/**
 * A fake ESPN score source (docs/FAKE-PROVIDER.md › Scripted game): answers the ESPN paths the server's sport collector
 * and fixtures read (server/services/sportsDashboard.js, sportsFixturesEspn.js) for ONE scripted Premier League game, so
 * a test can steer a game past its guide slot (#217's T3). Node built-ins only.
 *
 *   node scripts/fake-scores.js --game-at <ISO> [--guide-min 10] [--final-min 25] [--port 8443] [--host 127.0.0.1]
 *                               [--cert leaf.pem --key leaf.key]
 *
 * The game kicks off at --game-at: before it ESPN says `pre` (scheduled), from it `in` (live), and from --final-min
 * after it `post` (final). Its guide slot is --guide-min long (fake-provider.js --game-at writes that programme on ITV1),
 * so a recording of it overruns between the guide end and the final. With --cert/--key it serves HTTPS: the rig gives
 * it ESPN's host names on a private network and the staging server trusts its CA (scripts/unraid-rig.sh, PIGTV_RIG_SCORES).
 *
 *   /apis/site/v2/sports/soccer/eng.1/scoreboard   the game (whatever ?dates=), every other league's scoreboard is empty
 *   /apis/site/v2/sports/soccer/eng.1/teams        its two teams; cricket/scorepanel an empty list; anything else 404
 *   GET /fake/game                                 the timeline (kick-off, guide end, final, state now)
 *   POST /fake/game?final=now|<ISO>|<min>          move the final (min = minutes after kick-off)
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const MIN = 60 * 1000;

const team = (id, name, abbreviation) => ({ id, uid: `s:600~t:${id}`, location: name, name, displayName: name, shortDisplayName: name, abbreviation });
/** The scripted game: an ESPN Premier League fixture on ITV1 (no other fake event airs there). */
const GAME = {
    id: '9917001', league: 'EPL', path: 'soccer/eng.1', tvg: 'itv1.uk',
    title: 'Premier League: Everton v Fulham', home: team('368', 'Everton', 'EVE'), away: team('370', 'Fulham', 'FUL')
};

/**
 * The timeline: { start, guideEnd, finalAt, stateAt(now), programme() }. `finalAt` can be moved (setFinal).
 */
function scriptedGame({ at, guideMin = 10, finalMin = 25 }) {
    const start = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(start)) throw new Error('--game-at needs an ISO time');
    if (!(guideMin > 0) || !(finalMin > 0)) throw new Error('--guide-min and --final-min must be positive');
    const g = {
        ...GAME, start, guideEnd: start + guideMin * MIN, finalAt: start + finalMin * MIN,
        stateAt: (now) => now < g.start ? 'pre' : now < g.finalAt ? 'in' : 'post',
        setFinal(value, now = Date.now()) {
            const t = value === 'now' ? now : /^\d{1,4}$/.test(String(value)) ? g.start + Number(value) * MIN : Date.parse(value);
            if (!Number.isFinite(t) || t < g.start) throw new Error('final must be now, minutes after kick-off, or an ISO time after it');
            g.finalAt = t;
        },
        /** Its guide programme, as fake-provider.js's EVENTS give one (absolute times). */
        programme: () => ({ tvgs: [GAME.tvg], start: g.start, stop: g.guideEnd, title: GAME.title, categories: ['Sport', 'Football'], flag: 'live' })
    };
    return g;
}

/** ESPN's scoreboard answer for the game at `now` (the shape sportsScoresEspn.normalize and sportsFixturesEspn read). */
function scoreboard(game, now) {
    const state = game.stateAt(now);
    const minute = Math.max(1, Math.min(90, Math.floor((Math.min(now, game.finalAt) - game.start) / MIN) + 1));
    const goals = state === 'pre' ? null : [minute > 3 ? '1' : '0', minute > 15 ? '1' : '0'];
    const type = state === 'pre' ? { id: '1', name: 'STATUS_SCHEDULED', state: 'pre', completed: false, description: 'Scheduled', detail: 'Scheduled' }
        : state === 'in' ? { id: '2', name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, description: 'In Progress', detail: `${minute}'` }
            : { id: '28', name: 'STATUS_FULL_TIME', state: 'post', completed: true, description: 'Full Time', detail: 'FT' };
    const status = { clock: 0, displayClock: state === 'in' ? `${minute}'` : state === 'post' ? "90'" : "0'", period: state === 'pre' ? 0 : minute > 45 ? 2 : 1, type };
    const date = new Date(game.start).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
    const competitor = (t, homeAway, i) => ({ id: t.id, uid: t.uid, type: 'team', order: i, homeAway, team: t, ...(goals ? { score: goals[i] } : {}) });
    return {
        leagues: [{ id: '700', name: 'English Premier League', abbreviation: 'Prem', slug: 'eng.1' }],
        events: [{
            id: game.id, uid: `s:600~l:700~e:${game.id}`, date, name: `${game.away.displayName} at ${game.home.displayName}`,
            shortName: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
            competitions: [{ id: game.id, date, startDate: date, competitors: [competitor(game.home, 'home', 0), competitor(game.away, 'away', 1)], status }],
            status
        }]
    };
}

/** The request handler: ESPN's paths, and /fake/game. */
function handler(game, { log = () => {} } = {}) {
    const requests = { scoreboard: 0, other: 0 };
    const send = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    const timeline = (now) => ({ id: `espn:${game.path}:${game.id}`, title: game.title, tvg: game.tvg, start: game.start, guideEnd: game.guideEnd,
        finalAt: game.finalAt, state: game.stateAt(now), now, requests });
    return (req, res) => {
        let u;
        try { u = new URL(req.url, 'http://local'); } catch { return send(res, 400, { error: 'bad request' }); }
        const now = Date.now();
        if (u.pathname === '/fake/game') {
            if (req.method === 'POST') {
                try { game.setFinal(u.searchParams.get('final'), now); } catch (e) { return send(res, 400, { error: e.message }); }
                log(`final moved to ${new Date(game.finalAt).toISOString()}`);
            }
            return send(res, 200, timeline(now));
        }
        const m = /^\/apis\/site\/v2\/sports\/([a-z-]+\/[a-z0-9._-]+|cricket)\/(scoreboard|teams|scorepanel)$/i.exec(u.pathname);
        if (!m) { requests.other++; return send(res, 404, { error: 'not in the fake' }); }
        const [, path, what] = m;
        if (what === 'scorepanel') return send(res, 200, { scores: [] });
        if (path !== game.path) { requests.other++; return what === 'scoreboard' ? send(res, 200, { leagues: [], events: [] }) : send(res, 404, { error: 'not in the fake' }); }
        if (what === 'teams') return send(res, 200, { sports: [{ leagues: [{ teams: [{ team: game.home }, { team: game.away }] }] }] });
        requests.scoreboard++;
        return send(res, 200, scoreboard(game, now));
    };
}

/** createFakeScores({ at, guideMin, finalMin, cert, key }) -> { game, server, listen(port, host) -> base URL, close() } */
function createFakeScores({ at, guideMin, finalMin, cert = null, key = null, quiet = false } = {}) {
    const game = scriptedGame({ at, guideMin, finalMin });
    const log = (...a) => { if (!quiet) console.log('[fake scores]', ...a); };
    const tls = cert && key;
    const h = handler(game, { log });
    const server = tls ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, h) : http.createServer(h);
    return {
        game, server,
        listen(port = 8443, host = '127.0.0.1') {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => { server.off('error', reject); resolve(`${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`); });
            });
        },
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); })
    };
}

const USAGE = `Usage: node scripts/fake-scores.js --game-at <ISO> [options]
  --game-at ISO     kick-off of the scripted game (its guide start; give fake-provider.js the same --game-at)
  --guide-min N     its guide slot (10)
  --final-min N     minutes after kick-off when ESPN says it is final (25)
  --port N --host H listen (8443, 127.0.0.1)
  --cert F --key F  serve HTTPS with this certificate (the rig: ESPN's host names, its own CA)
  --quiet           no log lines`;

async function main() {
    const o = {};
    const map = { '--game-at': 'at', '--guide-min': 'guideMin', '--final-min': 'finalMin', '--port': 'port', '--host': 'host', '--cert': 'cert', '--key': 'key' };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--help' || argv[i] === '-h') { console.log(USAGE); return; }
        if (argv[i] === '--quiet') { o.quiet = true; continue; }
        const k = map[argv[i]];
        if (!k || i + 1 >= argv.length) { console.error(`bad option ${argv[i]}\n${USAGE}`); process.exit(2); }
        o[k] = ['guideMin', 'finalMin', 'port'].includes(k) ? Number(argv[++i]) : argv[++i];
    }
    if (!o.at) { console.error(USAGE); process.exit(2); }
    const { port = 8443, host = '127.0.0.1', ...rest } = o;
    const fake = createFakeScores(rest);
    const base = await fake.listen(port, host);
    const iso = (t) => new Date(t).toISOString();
    console.log(`fake scores on ${base} (listening on ${host}): "${GAME.title}" kick-off ${iso(fake.game.start)}, guide end ${iso(fake.game.guideEnd)}, final ${iso(fake.game.finalAt)}`);
    const stop = async () => { await fake.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { GAME, scriptedGame, scoreboard, handler, createFakeScores };
