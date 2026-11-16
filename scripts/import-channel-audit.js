#!/usr/bin/env node
// #265 step 2 (D-65): import the channel audit's measurements (its results.jsonl) as the channels' measured quality,
// which every channel object the clients see then carries as `measured: { label, fps }`.
// Admin only: run inside the container, from the app folder, against the server's own database:
//   docker exec PigTV node scripts/import-channel-audit.js /data/audit/<run>/results.jsonl
// Blank, failed and picture-less rows are ignored; the newest measurement of a channel wins (a later play's too).
// Nothing is fetched; the file holds no URLs (the audit refuses to write one).
const fs = require('fs');

const file = process.argv[2];
if (!file || file === '-h' || file === '--help') {
    console.error('usage: node scripts/import-channel-audit.js <results.jsonl>');
    process.exit(2);
}
let text;
try { text = fs.readFileSync(file, 'utf8'); } catch (err) { console.error(`Cannot read ${file}: ${err.message}`); process.exit(1); }
const { importAudit } = require('../server/services/channelMeasurements');
const r = importAudit(text);
console.log(`Channel audit import: ${r.read} rows read, ${r.imported} measurements kept, ${r.skipped} ignored (blank, failed, older or unreadable)`);
