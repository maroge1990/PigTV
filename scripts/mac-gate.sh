#!/usr/bin/env bash
# Push gate for the server (D-77), run on the MacBook from here: npm test with the speed budgets on, then verify-build.sh.
#
#   bash scripts/mac-gate.sh              test the commit (HEAD, via git archive): exactly what a push would carry
#   bash scripts/mac-gate.sh --worktree   test the working tree (tracked + untracked) for a pre-commit run
#   bash scripts/mac-gate.sh --only "test/a.test.js test/b.test.js"   rerun just those files (record says tier "only")
#
# PIGTV_MAC_HOST (default mac) and PIGTV_MAC_SSH_OPTS (e.g. "-o HostName=<ip>") say how to reach the Mac.
# Output goes to .gate-logs/; one record line per run is appended to .gate-log. Exit 0 only on PASS, 3 if the Mac is unreachable.
set -u
cd "$(dirname "$0")/.."
REPO=server; MODE=commit; ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --worktree) MODE=worktree ;;
        --only) ONLY="${2:-}"; shift ;;
        *) echo "usage: bash scripts/mac-gate.sh [--worktree] [--only \"test files\"]" >&2; exit 2 ;;
    esac
    shift
done
HOST="${PIGTV_MAC_HOST:-mac}"
# shellcheck disable=SC2206
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 ${PIGTV_MAC_SSH_OPTS:-})
mac() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

if ! mac true 2>/dev/null; then echo "mac-gate: cannot reach the Mac (host '$HOST'; set PIGTV_MAC_HOST / PIGTV_MAC_SSH_OPTS)" >&2; exit 3; fi

if [ "$MODE" = worktree ]; then WHAT="worktree (dirty)"; else WHAT="$(git rev-parse --short HEAD)"; fi
TIER=full; [ -n "$ONLY" ] && TIER=only
mkdir -p .gate-logs
LOG=".gate-logs/$(date -u +%Y%m%dT%H%M%SZ)-$REPO-$TIER.log"
B='$HOME/pigtv-build'; G="$B/gate-$REPO"

# One gate at a time on the Mac: a lock folder; a lock older than 3 h is reported, not taken over.
if ! mac "mkdir -p $B && mkdir $B/gate.lock 2>/dev/null && echo \"$REPO \$(date -u +%FT%TZ)\" > $B/gate.lock/owner"; then
    OWNER="$(mac "cat $B/gate.lock/owner 2>/dev/null")"
    if [ -n "$(mac "find $B/gate.lock -maxdepth 0 -mmin +180 2>/dev/null")" ]; then
        echo "mac-gate: STALE lock (older than 3 h, owner: $OWNER). Check the Mac, then: ssh $HOST 'rm -rf ~/pigtv-build/gate.lock'" >&2
    else
        echo "mac-gate: another gate run is in progress on the Mac (owner: $OWNER)" >&2
    fi
    exit 4
fi
trap 'mac "rm -rf $B/gate.lock" >/dev/null 2>&1' EXIT

START=$(date +%s)
{
    echo "== export $WHAT -> Mac"
    mac "mkdir -p $G && rm -rf $G/src && mkdir -p $G/src"
    if [ "$MODE" = worktree ]; then
        rsync -a -e "ssh ${SSH_OPTS[*]}" --exclude .git --exclude node_modules --exclude data --exclude user_data --exclude coverage \
            --exclude .gate-log --exclude .gate-logs --exclude .claude ./ "$HOST:pigtv-build/gate-server/src/" || exit 1
    else
        git archive HEAD | mac "tar -x -C $G/src"
    fi
    echo "== run on the Mac"
    mac "REPO_G=$G ONLY='$ONLY' sh -s" <<'REMOTE'
export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH
unset PIGTV_SKIP_PERF
# a throwaway TMPDIR: a full /tmp hangs tests (AGENTS memory)
export TMPDIR="$REPO_G/tmp"; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
cd "$REPO_G/src" || exit 1
node -v
HASH=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
if [ -d "$REPO_G/node_modules" ] && [ "$(cat "$REPO_G/lock.sha" 2>/dev/null)" = "$HASH" ]; then
    echo "== node_modules reused (package-lock unchanged)"
else
    echo "== npm ci (package-lock changed)"; rm -rf "$REPO_G/node_modules" "$REPO_G/lock.sha"
    npm ci --no-audit --no-fund || { echo "GATE-STEP-FAILED npm ci"; exit 1; }
    mv node_modules "$REPO_G/node_modules"; echo "$HASH" > "$REPO_G/lock.sha"
fi
ln -s "$REPO_G/node_modules" node_modules
RC=0
if [ -n "$ONLY" ]; then
    echo "== node --test $ONLY"; node --test $ONLY || RC=1
else
    echo "== npm test (speed budgets on)"; npm test || RC=1
    echo "== verify-build.sh"; bash scripts/verify-build.sh . || { RC=1; echo "GATE-STEP-FAILED verify-build"; }
fi
rm -rf "$TMPDIR"
[ $RC = 0 ] && echo "GATE-RESULT PASS" || echo "GATE-RESULT FAIL"
exit $RC
REMOTE
} >"$LOG" 2>&1
RC=$?
SECS=$(( $(date +%s) - START ))

if [ $RC = 0 ] && grep -q "^GATE-RESULT PASS" "$LOG"; then RES=PASS; else RES=FAIL; RC=1; fi
# failed test names: spec reporter "✖ name" or TAP "not ok N - name"; first 10, unique, skipping the file-level and summary lines
FAILED="$(grep -E '^\s*(✖|not ok [0-9]+ -)' "$LOG" | sed -E 's/^\s*(✖|not ok [0-9]+ -) *//; s/ \([0-9.]+ms\)$//' \
    | grep -vE '^(failing tests:|$)' | awk '!s[$0]++' | head -10 | paste -sd'|' -)"
grep -q "GATE-STEP-FAILED" "$LOG" && FAILED="$FAILED${FAILED:+|}$(grep -m1 GATE-STEP-FAILED "$LOG" | sed 's/GATE-STEP-FAILED //')"
echo "$(date -u +%FT%TZ) $REPO $WHAT $TIER $RES ${SECS}s ${FAILED:--}" >> .gate-log
COUNTS="$(grep -E '^(ℹ|#) (tests|pass|fail|skipped) ' "$LOG" | sed -E 's/^(ℹ|#) //' | paste -sd' ' -)"
echo "mac-gate $REPO $WHAT: $RES in ${SECS}s ${COUNTS:+($COUNTS)}"
[ -n "$FAILED" ] && echo "failed: $FAILED"
echo "log: $LOG"
exit $RC
