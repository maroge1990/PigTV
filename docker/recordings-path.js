// Prints the configured recordings folder for the container entrypoint's write
// probe. Opens the database read-only and as the unprivileged user (never as
// root, which would leave root-owned -wal/-shm files behind); any problem
// falls back to the default, which is what the server itself would use.
const DEFAULT = '/app/recordings';
try {
    const Database = require('better-sqlite3');
    const db = new Database('/app/data/content.db', { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'recordingsPath'").get();
    db.close();
    const v = row && JSON.parse(row.value);
    console.log(typeof v === 'string' && v ? v : DEFAULT);
} catch {
    console.log(DEFAULT);
}
