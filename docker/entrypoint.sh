#!/bin/sh
# PigTV container entrypoint (R17).
#
# Starts as root for the few things only root can do, then drops to PUID:PGID
# (default 99:100, Unraid's nobody:users) and replaces itself with node, so the
# server is PID 1's direct child-by-exec and SIGTERM reaches it for the
# graceful recording shutdown in server/index.js.
#
# Deliberately NOT done here: touching the recordings share. It is a network
# mount that can be huge, slow or refuse chown; it is only probed (see below).
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
APP=/app

log() { echo "[entrypoint] $*"; }

case "$PUID$PGID" in
    ''|*[!0-9]*) log "PUID ('$PUID') and PGID ('$PGID') must be plain numbers; refusing to start."; exit 1 ;;
esac

# Escape hatch: PUID=0 means "run as root", for a setup that cannot be fixed
# with permissions. Said loudly because it is rarely what you want.
if [ "$PUID" = "0" ]; then
    log "PUID=0: running as root with no privilege drop. Set PUID/PGID (default 99:100) to run unprivileged."
    exec "$@"
fi

# The container's own writable folders. chown only when something is wrong, so
# a normal restart costs a stat and a find rather than a recursive rewrite.
fix_owner() {
    d="$1"
    mkdir -p "$d" 2>/dev/null || true
    [ -d "$d" ] || return 0
    if [ "$(stat -c %u:%g "$d")" != "$PUID:$PGID" ] || [ -n "$(find "$d" ! -user "$PUID" -print -quit 2>/dev/null)" ]; then
        log "fixing ownership of $d to $PUID:$PGID"
        chown -R "$PUID:$PGID" "$d" 2>/dev/null || log "WARNING: could not chown $d (read-only mount?); continuing."
    fi
}
fix_owner "$APP/data"
fix_owner "$APP/transcode-cache"
fix_owner "$APP/config"

# VAAPI: the render node belongs to whatever group the host gave it. Join that
# group so hardware encoding keeps working without running as root. A device
# owned by group 0 is skipped (adding root's group would hand over more than
# the GPU); it works as long as the device is world read/write, as on Unraid.
GROUPS_ARG=""
for dev in /dev/dri/renderD* /dev/dri/card*; do
    [ -e "$dev" ] || continue
    gid="$(stat -c %g "$dev")"
    if [ "$gid" = "0" ]; then
        other=$(( $(stat -c %a "$dev") % 10 ))
        [ $(( other & 6 )) -eq 6 ] || log "WARNING: $dev is root-only (group 0, not world read/write); VAAPI will not work as $PUID. Fix the host device permissions or set PUID=0."
        continue
    fi
    case ",$GROUPS_ARG," in *",$gid,"*) ;; *) GROUPS_ARG="${GROUPS_ARG:+$GROUPS_ARG,}$gid" ;; esac
done
[ -n "$GROUPS_ARG" ] && log "VAAPI: adding device group(s) $GROUPS_ARG"

# setpriv ships in util-linux, which Ubuntu already has: no extra download.
# Explicit --groups, so no passwd entry for the numeric user is needed.
if [ -n "$GROUPS_ARG" ]; then GRP="--groups=$GROUPS_ARG"; else GRP="--clear-groups"; fi
run_as() { setpriv --reuid="$PUID" --regid="$PGID" "$GRP" --no-new-privs -- "$@"; }
export HOME=/tmp

# Recordings: can the runtime user create and delete a file there? Probe only;
# the folder-health check on the Status page reports it from then on.
REC="$(run_as node "$APP/docker/recordings-path.js" 2>/dev/null || true)"
[ -n "$REC" ] || REC="$APP/recordings"
PROBE="$REC/.pigtv-write-test-$$"
if run_as sh -c ': > "$1" && rm -f "$1"' sh "$PROBE" 2>/dev/null; then
    log "recordings folder $REC is writable by $PUID:$PGID"
else
    log "WARNING: user $PUID:$PGID cannot write to the recordings folder $REC. Give that user write access on the share (Unraid: Shares > SMB/NFS security, or the mount's UID/GID options), or set PUID/PGID to a user that can. Recording will fail until fixed; everything else works."
fi

log "starting as $PUID:$PGID"
exec setpriv --reuid="$PUID" --regid="$PGID" "$GRP" --no-new-privs -- "$@"
