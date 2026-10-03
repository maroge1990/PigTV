# PigTV operations

Running the container on Unraid (or anywhere else). Image: `ghcr.io/maroge1990/pigtv`.

## Running as a normal user (PUID / PGID)

The server no longer runs as root. The entrypoint (`docker/entrypoint.sh`) starts as root only to
prepare folders, then drops to `PUID:PGID` and `exec`s node, so `docker stop` (SIGTERM) still reaches
the server and in-progress recordings are closed cleanly.

- Defaults: `PUID=99`, `PGID=100` (Unraid's `nobody:users`). Both are optional.
- `PUID=0` runs as root with no drop (escape hatch; logged).
- At start it fixes ownership of the container's own folders only (`/app/data`, `/app/transcode-cache`,
  `/app/config`), and only when something is wrong, so normal restarts are cheap.
- It never changes ownership of `/app/recordings`. That is a network share and may be huge or refuse
  `chown`. It only tries to create and delete a file there as the runtime user.
- VAAPI: if `/dev/dri/renderD128` or `card*` is owned by a non-root group, the user joins that group.
  A root-group device works if it is world read/write (Unraid's default).

### Unraid template additions

Add two optional Variables to the `PigTV` container template:

| Name | Key | Default |
|------|-----|---------|
| User ID | `PUID` | `99` |
| Group ID | `PGID` | `100` |

Nothing else changes: `/mnt/user/appdata/nodecast_tv/data` -> `/app/data`, `/mnt/remotes` -> `/app/recordings`
(Read/Write - Slave), the transcode tmpfs, and the `/dev/dri` device stay as they are.

## First deploy of the non-root image: checklist

1. Force Update the container. Check the log. Expect, in order:
   - `[entrypoint] fixing ownership of /app/data to 99:100` (first start only; later starts do not print it)
   - `[entrypoint] VAAPI: adding device group(s) ...` (only if the render node has a non-root group)
   - `[entrypoint] recordings folder /app/recordings is writable by 99:100`
   - `[entrypoint] starting as 99:100`, then `PigTV server running on ...`
2. Open Status in the web app: the recordings folder should be OK, and VAAPI/ffmpeg encoders listed.
3. Start a live channel with hardware transcoding and confirm it still uses VAAPI.
4. If the log says `user 99:100 cannot write to the recordings folder <path>`: the SMB share does not let
   that user write. Either give that user write access on the share (Unraid: Shares -> SMB security, or
   the remote mount's UID/GID options), or set `PUID`/`PGID` to a user that can. Everything except
   recording works meanwhile; the Status page keeps reporting the folder problem.
5. If the log says a `/dev/dri` device is root-only, fix the host device permissions or set `PUID=0`.
6. Rolling back: set `PUID=0`, or pull the previous image tag.

## Health check

`GET /api/health` is unauthenticated and returns `{ "ok": true, "db": true, "recordingsFolder": true }`.
`recordingsFolder` is the last periodic check held in memory (`null` before the first one), so a call
never touches the share. A bad recordings folder does not fail the check (restarting would not fix a
share); only an unusable database returns 503. The image `HEALTHCHECK` calls it every 30 s; Unraid shows
the container as healthy/unhealthy.

## Backup

```
docker exec PigTV sh scripts/backup-db.sh
```

Writes an application-consistent copy (SQLite online backup, safe while the server runs) to
`/app/data/backups/content-<timestamp>.db` and keeps the newest 7. On Unraid that is
`/mnt/user/appdata/nodecast_tv/data/backups/`. Schedule it with the User Scripts plugin.

## Restore

1. Stop the container.
2. In the data folder, remove `content.db-wal` and `content.db-shm` if present, then copy the backup over:
   `cp backups/content-<timestamp>.db content.db`
3. Make sure the owner matches (`chown 99:100 content.db`; the entrypoint also corrects this at start).
4. Start the container and check the log and Status page.
