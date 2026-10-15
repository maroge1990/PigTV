// Application-consistent copy of the SQLite database, via better-sqlite3's
// online backup API (a plain `cp` of a WAL database can miss committed data).
// Run inside the container: docker exec PigTV sh scripts/backup-db.sh
// The server also takes one nightly and one before a new build's migrations (R12,
// services/dbBackup.js); this is the same copy, on demand, sharing the newest-7 rotation.
const path = require('path');
const dbBackup = require('../server/services/dbBackup');

const dataDir = process.env.PIGTV_DATA_DIR || path.join(__dirname, '..', 'data');

dbBackup.backup(path.join(dataDir, 'content.db'), { reason: 'manual' })
    .then(file => console.log(`Backup written: ${file}`))
    .catch(err => { console.error('Backup failed:', err.message); process.exit(1); });
