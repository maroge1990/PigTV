// Application-consistent copy of the SQLite database, via better-sqlite3's
// online backup API (a plain `cp` of a WAL database can miss committed data).
// Run inside the container: docker exec PigTV sh scripts/backup-db.sh
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.PIGTV_DATA_DIR || path.join(__dirname, '..', 'data');
const dir = path.join(dataDir, 'backups');
const KEEP = 7;

(async () => {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
    const dest = path.join(dir, `content-${stamp}.db`);
    const db = new Database(path.join(dataDir, 'content.db'), { readonly: true, fileMustExist: true });
    try { await db.backup(dest); } finally { db.close(); }
    console.log(`Backup written: ${dest} (${fs.statSync(dest).size} bytes)`);
    // Timestamps sort lexically, so the oldest are first.
    const old = fs.readdirSync(dir).filter(f => /^content-.*\.db$/.test(f)).sort().slice(0, -KEEP);
    for (const f of old) { fs.unlinkSync(path.join(dir, f)); console.log(`Removed old backup: ${f}`); }
})().catch(err => { console.error('Backup failed:', err.message); process.exit(1); });
