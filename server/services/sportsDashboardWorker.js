const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { createStore } = require('./sportsDashboardStore');
const { buildDashboard } = require('./sportsDashboard');
const db = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const store = createStore(db, { readOnly: true });
parentPort.on('message', ({ id, eventsBody, options }) => {
    try {
        const { events } = JSON.parse(Buffer.from(eventsBody).toString('utf8'));
        const response = buildDashboard(store, { ...options, events });
        parentPort.postMessage({ id, response });
    } catch { parentPort.postMessage({ id, error: true }); }
});
