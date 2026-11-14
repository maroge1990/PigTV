const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { createStore } = require('./sportsDashboardStore');
const { buildDashboard } = require('./sportsDashboard');
const db = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
// Opened on the first collector job: #282's schedule jobs (score collector off) never read its tables, which may not exist.
let store = null;
parentPort.on('message', ({ id, eventsBody, options }) => {
    try {
        const { events } = JSON.parse(Buffer.from(eventsBody).toString('utf8'));
        const source = options.schedule ? require('./sportsFixtures').scheduleStore(db, options.leagues || new Set())
            : store || (store = createStore(db, { readOnly: true }));
        const response = buildDashboard(source, { ...options, events });
        parentPort.postMessage({ id, response });
    } catch { parentPort.postMessage({ id, error: true }); }
});
