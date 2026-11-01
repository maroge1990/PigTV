/**
 * #201 (C-P `info.map`): an SVG drawn to a transparent PNG of a given width, for clients that cannot draw SVG (the
 * Apple TV). resvg as WebAssembly (@resvg/resvg-wasm: no native build), loaded only inside a draw's worker, so nothing
 * that opens the database or starts the server loads it. No system fonts are read: the maps carry no text.
 *
 * 0425 (0424 Codex round 1, high): any registered SVG (a provider's channel logo too) can be asked for, so a draw is
 * bounded. The SVG's own size is read after parsing and the draw refused before rendering when the PNG would be taller
 * than MAX_HEIGHT or hold more than MAX_PIXELS (WASM memory is outside a worker's resourceLimits: this is the memory
 * guard). Parse, render and encode run in a worker_threads Worker with a heap limit and a hard deadline (terminated
 * then). One draw at a time; a second request for the same key shares the first's; at most `limits.maxQueue` wait,
 * and beyond that `draw` rejects with code BUSY (the caller answers 503 and remembers nothing).
 *
 * `draw(key, buffer, width)` -> PNG bytes, or rejects: code TOO_LARGE, TIMEOUT, BUSY, or a draw error.
 */
const { Worker } = require('worker_threads');

const MAX_WIDTH = 3840, MAX_HEIGHT = 4320, MAX_PIXELS = 3840 * 4320;
const limits = { timeoutMs: 10000, maxQueue: 4, heapMb: 256 }; // settable by tests
const stats = { workers: 0 };                                    // tests: how many draws actually ran

// The worker: parse, check the output size, then render and encode. Runs as an eval'd script (no extra file to ship).
const WORKER = `
const { parentPort, workerData } = require('worker_threads');
(async () => {
    const fs = require('fs');
    const resvg = require(workerData.module);
    await resvg.initWasm(fs.readFileSync(workerData.wasm));
    const svg = new resvg.Resvg(Buffer.from(workerData.svg).toString('utf8'), {
        fitTo: { mode: 'width', value: workerData.width }, background: 'rgba(0, 0, 0, 0)', font: { loadSystemFonts: false } });
    try {
        const w = svg.width, h = svg.height;
        const outW = workerData.width, outH = Math.ceil(outW * h / w);
        if (!(w > 0 && h > 0) || !Number.isFinite(outH) || outH > workerData.maxHeight || outW * outH > workerData.maxPixels) {
            return parentPort.postMessage({ refused: \`would be \${outW}x\${outH}\` });
        }
        const image = svg.render();
        try { const png = image.asPng(); parentPort.postMessage({ png }, [png.buffer]); } finally { image.free(); }
    } finally { svg.free(); }
})().catch(err => parentPort.postMessage({ error: String(err && err.message || err) }));
`;

function failure(code, message) { const err = new Error(message); err.code = code; return err; }

/** One draw in its own worker, terminated at the deadline. */
function run(buffer, width) {
    stats.workers++;
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: limits.heapMb },
            workerData: { svg: new Uint8Array(buffer), width, maxHeight: MAX_HEIGHT, maxPixels: MAX_PIXELS,
                module: require.resolve('@resvg/resvg-wasm'), wasm: require.resolve('@resvg/resvg-wasm/index_bg.wasm') } });
        let settled = false;
        const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(value); };
        const timer = setTimeout(() => settle(reject, failure('TIMEOUT', `draw took over ${limits.timeoutMs} ms`)), limits.timeoutMs);
        worker.on('message', (m) => {
            if (m?.png) settle(resolve, Buffer.from(m.png));
            else if (m?.refused) settle(reject, failure('TOO_LARGE', `refused: ${m.refused}`));
            else settle(reject, new Error(m?.error || 'draw failed'));
        });
        worker.on('error', (err) => settle(reject, err));
        worker.on('exit', (code) => settle(reject, new Error(`draw worker exited ${code}`)));
    });
}

const inFlight = new Map(); // key -> promise (the running or queued draw)
let chain = Promise.resolve(); // one draw at a time
let waiting = 0;            // draws queued or running

function draw(key, buffer, width = MAX_WIDTH) {
    const known = inFlight.get(key);
    if (known) return known;
    if (waiting >= limits.maxQueue) return Promise.reject(failure('BUSY', 'too many images waiting to be drawn'));
    waiting++;
    const mine = chain.then(() => run(buffer, Math.min(width, MAX_WIDTH)));
    chain = mine.catch(() => {});
    const shared = mine.finally(() => { waiting--; inFlight.delete(key); });
    inFlight.set(key, shared);
    return shared;
}

module.exports = { draw, limits, stats, MAX_WIDTH, MAX_HEIGHT, MAX_PIXELS };
