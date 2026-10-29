/** Dashboard projection never falls back onto the serving/HLS loop. One read-only worker, bounded queue. */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
let worker = null, active = null, sequence = 0;
const queued = [];
function failAll() {
    const error = new Error('Sports dashboard worker unavailable');
    active?.reject(error); active = null;
    for (const item of queued.splice(0)) item.reject(error);
}
function dispatch() {
    if (active || !queued.length) return;
    if (!worker) {
        const w = new Worker(path.join(__dirname, 'sportsDashboardWorker.js'), {
            workerData: { databasePath: require('../db/sqlite').databasePath(), pigtvReadOnlyDb: true }
        });
        worker = w;
        w.on('message', message => {
            if (worker !== w || !active || message.id !== active.id) return;
            const job = active; active = null;
            if (message.error) job.reject(new Error('Could not build sports dashboard'));
            else job.resolve(message.response);
            w.unref(); dispatch();
        });
        w.on('error', () => { if (worker === w) { worker = null; failAll(); w.terminate(); } });
        w.on('exit', () => { if (worker === w) { worker = null; failAll(); } });
    }
    active = queued.shift(); worker.ref();
    try { worker.postMessage({ id: active.id, ...active.options }); }
    catch { failAll(); }
}
function response(options) {
    if (queued.length + Number(Boolean(active)) >= 8) return Promise.reject(new Error('Sports dashboard busy'));
    // Keep the events as cached JSON bytes: parsing and joining happen on the worker too.
    return new Promise((resolve, reject) => { queued.push({ id: ++sequence, options, resolve, reject }); dispatch(); });
}
function close() {
    const old = worker; worker = null; failAll();
    if (old) old.terminate();
}
module.exports = { response, close };
