/**
 * #201 (C-P `info.map`): an SVG drawn to a transparent PNG of a given width, for clients that cannot draw SVG (the
 * Apple TV). resvg as WebAssembly (@resvg/resvg-wasm: no native build), loaded on the first draw only, so nothing that
 * opens the database or starts the server loads it. No system fonts are read: the maps carry no text.
 *
 * `svgToPng(buffer, width)` -> PNG bytes, or rejects (a broken SVG, or the module could not load). The caller decides
 * the fallback; nothing here retries.
 */
let ready = null; // the one initialisation, kept whether it worked or not

function load() {
    if (!ready) {
        ready = (async () => {
            const resvg = require('@resvg/resvg-wasm');
            const fs = require('fs');
            await resvg.initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
            return resvg;
        })();
        ready.catch(() => { /* every caller sees the rejection */ });
    }
    return ready;
}

async function svgToPng(buffer, width) {
    const { Resvg } = await load();
    const svg = new Resvg(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer), {
        fitTo: { mode: 'width', value: width }, background: 'rgba(0, 0, 0, 0)', font: { loadSystemFonts: false }
    });
    try {
        const image = svg.render();
        try { return Buffer.from(image.asPng()); } finally { image.free(); }
    } finally { svg.free(); }
}

module.exports = { svgToPng };
