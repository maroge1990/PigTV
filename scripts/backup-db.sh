#!/bin/sh
# Backs up /app/data/content.db to /app/data/backups/ (newest 7 kept).
#   docker exec PigTV sh scripts/backup-db.sh
cd "$(dirname "$0")/.." || exit 1
# docker exec starts as root. Opening the database as root could leave
# root-owned -wal/-shm files the server (running unprivileged) then cannot use,
# so step down to whoever owns the data folder first.
if [ "$(id -u)" = "0" ] && [ -d data ] && [ "$(stat -c %u data)" != "0" ]; then
    exec setpriv --reuid="$(stat -c %u data)" --regid="$(stat -c %g data)" --clear-groups -- node scripts/backup-db.js
fi
exec node scripts/backup-db.js
