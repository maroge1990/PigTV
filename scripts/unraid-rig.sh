#!/usr/bin/env bash
#
# PigTV test rig on the Unraid box (docs/FAKE-PROVIDER.md "Test rig on Unraid").
#
# Runs the Mac's working tree (synced over SSH, never a CI image) in CPU-capped TEST containers next to
# production. It never touches the production container (PIGTV_RIG_PROD, read only by `status`), its
# appdata or its image tag (every run is --pull never), and no real provider is ever involved: the only
# sources are the fake providers (scripts/fake-provider.js).
#
#   scripts/unraid-rig.sh sync     copy the working tree to the box (no .git, node_modules or ignored files)
#   scripts/unraid-rig.sh up       sync, (re)start the fake provider(s) and the staging server, seed and re-sync it
#   scripts/unraid-rig.sh check    staging smoke test: channels, guide, sport events, one channel to HLS
#   scripts/unraid-rig.sh status   what is running, resource use, disk, production's uptime and image (read only)
#   scripts/unraid-rig.sh test     sync, then npm test (PIGTV_SKIP_PERF=1) and verify-build.sh in a throwaway runner
#   scripts/unraid-rig.sh down     stop and remove the rig's containers (data kept)
#   scripts/unraid-rig.sh reset    down, then wipe the staging data and the local admin file (next `up` starts fresh)
#
# Settings (environment):
#   PIGTV_RIG_HOST        ssh alias of the box (passyflix); commands run there as the alias's user
#   PIGTV_RIG_ROOT        everything the rig keeps on the box (/mnt/user/appdata/pigtv-test)
#   PIGTV_RIG_IMAGE       runtime image, used as it is on the box (ghcr.io/maroge1990/pigtv:latest)
#   PIGTV_RIG_PORT        staging server's port on the box (3100)
#   PIGTV_RIG_FAKE_PORT   fake provider, profile a (8290); PIGTV_RIG_FAKE_B_PORT profile b, the backup (8291; 0 = none)
#   PIGTV_RIG_LAN_IP      the box's LAN address, which the staging server uses to reach the fakes (detected)
#   PIGTV_RIG_CREDS       local file for the staging admin made by `up` (~/.local/state/pigtv-rig/staging-admin.env).
#                         A throwaway login for the staging server only, generated on first `up`; keep it out of the repo.
#   PIGTV_RIG_FAKE_FLAGS  extra fake-provider flags (default: a CPU-frugal picture)
#   PIGTV_RIG_SPORT_FIXTURES  1 lets staging fetch ESPN's free sport feeds (the sport pages, C-P); default 0. ESPN is
#                         not a provider: no provider connection is opened either way.
#
# Limits on every container (Mark, 30 Oct): <= 3 CPUs, cpu-shares 256, <= 6 GB, --restart no, names pigtv-test-*,
# data only under PIGTV_RIG_ROOT (keep it under 20 GB).
set -euo pipefail

HOST="${PIGTV_RIG_HOST:-passyflix}"
ROOT="${PIGTV_RIG_ROOT:-/mnt/user/appdata/pigtv-test}"
IMAGE="${PIGTV_RIG_IMAGE:-ghcr.io/maroge1990/pigtv:latest}"
PORT="${PIGTV_RIG_PORT:-3100}"
FAKE_PORT="${PIGTV_RIG_FAKE_PORT:-8290}"
FAKE_B_PORT="${PIGTV_RIG_FAKE_B_PORT:-8291}"
LAN_IP="${PIGTV_RIG_LAN_IP:-}"
CREDS="${PIGTV_RIG_CREDS:-${XDG_STATE_HOME:-$HOME/.local/state}/pigtv-rig/staging-admin.env}"
FAKE_FLAGS="${PIGTV_RIG_FAKE_FLAGS:---fps 15 --size 480x270 --uhd-size 640x360 --video-kbps 400}"
PROD="${PIGTV_RIG_PROD:-PigTV}"
TZ_RIG="${PIGTV_RIG_TZ:-Australia/Sydney}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Container names and caps. Fixed on purpose: these are the agreed limits.
STAGING=pigtv-test-staging
FAKE_A=pigtv-test-fake-a
FAKE_B=pigtv-test-fake-b
RUNNER=pigtv-test-runner
CAPS=(--restart no --pull never --cpu-shares 256)
RUNTIME_UID=99:100

die() { echo "unraid-rig: $*" >&2; exit 1; }
say() { echo "== $*"; }

# Every value that is pasted into a remote command line must be plain.
for v in "$HOST" "$ROOT" "$IMAGE" "$PORT" "$FAKE_PORT" "$FAKE_B_PORT" "$PROD" "$TZ_RIG" "$LAN_IP"; do
    [[ "$v" =~ ^[A-Za-z0-9_./:@+-]*$ ]] || die "unsafe setting: '$v'"
done
[[ "$FAKE_FLAGS" =~ ^[A-Za-z0-9_.=x\ -]*$ ]] || die "unsafe PIGTV_RIG_FAKE_FLAGS"
[[ "$ROOT" == /mnt/*/appdata/pigtv-test* ]] || die "PIGTV_RIG_ROOT must be under /mnt/*/appdata/pigtv-test"

SRC="$ROOT/src"
# Docker's "no swap limit" notice on Unraid is noise; everything else on stderr is kept.
rsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@" 2> >(grep -v 'swap limit capabilities' >&2); }

lan_ip() {
    if [ -z "$LAN_IP" ]; then
        LAN_IP="$(rsh "ip -4 route get 1.1.1.1" | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
        [ -n "$LAN_IP" ] || die "could not detect the box's LAN address; set PIGTV_RIG_LAN_IP"
    fi
}

# ------------------------------------------------------------------ sync ---
cmd_sync() {
    command -v git >/dev/null || die "git is needed to list the ignored files"
    local ex; ex="$(mktemp)"
    # Never .git; nothing git ignores (data/, .env, logs, node_modules, transcode-cache, local notes).
    { echo "/.git/"; echo "node_modules/";
      git -C "$REPO" ls-files -o -i --exclude-standard --directory | sed 's|^|/|'; } > "$ex"
    rsh "mkdir -p '$SRC'"
    say "sync $REPO -> $HOST:$SRC"
    local t0=$SECONDS
    rsync -rlptz --delete --exclude-from="$ex" "$REPO/" "$HOST:$SRC/"
    rm -f "$ex"
    # The runtime user owns the copy (tests write beside it); a mountpoint the runner left stays.
    rsh "chown -R $RUNTIME_UID '$SRC'"
    git -C "$REPO" rev-parse --short HEAD > /dev/null 2>&1 && {
        local rev; rev="$(git -C "$REPO" rev-parse --short HEAD)"
        [ -z "$(git -C "$REPO" status --porcelain)" ] || rev="$rev+wip"
        echo "$rev" | rsh "cat > '$ROOT/src-rev'"
    }
    echo "   synced in $((SECONDS - t0)) s ($(rsh "cat '$ROOT/src-rev' 2>/dev/null"))"
}

# -------------------------------------------------------------------- up ---
run_fake() { # name port profile
    local name="$1" port="$2" profile="$3"
    rsh "docker run -d --name $name ${CAPS[*]} --no-healthcheck --cpus 1.5 --memory 512m --user $RUNTIME_UID \
           -e HOME=/tmp -e TZ=$TZ_RIG -p $port:$port -v '$SRC':/src:ro -w /src --entrypoint node '$IMAGE' \
           scripts/fake-provider.js --host 0.0.0.0 --port $port --profile $profile $FAKE_FLAGS >/dev/null"
}

cmd_up() {
    cmd_sync
    lan_ip
    rsh "docker rm -f $STAGING $FAKE_A $FAKE_B >/dev/null 2>&1 || true"
    for p in "$PORT" "$FAKE_PORT" "$FAKE_B_PORT"; do
        [ "$p" = 0 ] && continue
        [ -z "$(rsh "ss -ltnH 'sport = :$p'")" ] || die "port $p is already in use on $HOST"
    done

    say "fake provider a on $LAN_IP:$FAKE_PORT"
    run_fake "$FAKE_A" "$FAKE_PORT" a
    if [ "$FAKE_B_PORT" != 0 ]; then
        say "fake provider b on $LAN_IP:$FAKE_B_PORT"
        run_fake "$FAKE_B" "$FAKE_B_PORT" b
    fi

    # The synced server/, public/, scripts/ and docker/ over the image's; the image keeps node_modules
    # (its better-sqlite3 was built for its own Node). A changed lockfile is reported, not papered over.
    local rev; rev="$(rsh "cat '$ROOT/src-rev' 2>/dev/null || echo rig")"
    say "staging server on $LAN_IP:$PORT ($rev)"
    rsh "set -e; mkdir -p '$ROOT/staging/data' '$ROOT/staging/recordings'
         chown $RUNTIME_UID '$ROOT/staging/data' '$ROOT/staging/recordings'
         docker run -d --name $STAGING ${CAPS[*]} --cpus 3 --memory 4g -p $PORT:3000 \
           -e TZ=$TZ_RIG -e PUID=99 -e PGID=100 -e NODE_ENV=production -e PIGTV_SPORT_FIXTURES=${PIGTV_RIG_SPORT_FIXTURES:-0} \
           -e PIGTV_COMMIT='rig-$rev' -e PIGTV_BUILT_AT=\$(date -u +%FT%TZ) \
           -v '$SRC/server':/app/server:ro -v '$SRC/public':/app/public:ro \
           -v '$SRC/scripts':/app/scripts:ro -v '$SRC/docker':/app/docker:ro \
           -v '$ROOT/staging/data':/app/data -v '$ROOT/staging/recordings':/app/recordings \
           --tmpfs /app/transcode-cache:size=1g,uid=99,gid=100 '$IMAGE' >/dev/null
         if ! docker run --rm --pull never --entrypoint cat '$IMAGE' /app/package-lock.json | cmp -s - '$SRC/package-lock.json'; then
           echo '   WARNING: package-lock.json differs from the image: staging runs the image node_modules'
         fi"
    seed
    cmd_check
}

# Runs a Node program inside the staging container against http://localhost:3000 only. The program
# text (with the throwaway admin login in it) goes over stdin: nothing is written on the box.
staging_node() { # mode
    local user pass
    # shellcheck disable=SC1090
    . "$CREDS"
    user="$PIGTV_RIG_ADMIN_USER"; pass="$PIGTV_RIG_ADMIN_PASS"
    { printf 'const CFG = {"mode":"%s","user":"%s","pass":"%s","fakes":[%s]};\n' "$1" "$user" "$pass" "$(fakes_json)"
      cat <<'JS'
const BASE = 'http://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let token = null;
async function api(method, path, body) {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(json && json.error) || text.slice(0, 200)}`);
    return json;
}
async function waitHealthy() {
    for (let i = 0; i < 90; i++) {
        try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch { /* starting */ }
        await sleep(1000);
    }
    throw new Error('staging did not become healthy in 90 s');
}
async function signIn() {
    const { setupRequired } = await api('GET', '/api/auth/setup-required');
    if (setupRequired) {
        token = (await api('POST', '/api/auth/setup', { username: CFG.user, password: CFG.pass })).token;
        console.log('   created the staging admin');
    } else {
        try {
            token = (await api('POST', '/api/auth/login', { username: CFG.user, password: CFG.pass })).token;
        } catch (e) {
            throw new Error(`${e.message}: staging has an admin this login file does not match (run "unraid-rig.sh reset")`);
        }
    }
}
async function waitSynced(ids, since) {
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
        const rows = await api('GET', '/api/sources/status');
        const done = ids.every(id => {
            const mine = rows.filter(r => r.source_id === id);
            return mine.some(r => r.last_sync >= since) && !mine.some(r => r.status === 'syncing');
        });
        if (done) {
            for (const r of rows.filter(r => ids.includes(r.source_id))) {
                console.log(`   source ${r.source_id} ${r.type}: ${r.status}${r.error ? ' (' + r.error + ')' : ''}`);
            }
            return;
        }
        await sleep(2000);
    }
    throw new Error('sync did not finish in 300 s');
}
async function seed() {
    await waitHealthy();
    await signIn();
    const have = await api('GET', '/api/sources');
    const ids = [];
    const since = Date.now() - 1000;
    for (const f of CFG.fakes) {
        const s = have.find(x => x.name === f.name);
        if (s) {
            await api('POST', `/api/sources/${s.id}/sync`);
            ids.push(s.id);
            console.log(`   re-syncing ${f.name}`);
        } else {
            const made = await api('POST', '/api/sources', { type: 'xtream', name: f.name, url: f.url, username: f.user, password: f.pass });
            ids.push(made.id);
            console.log(`   added ${f.name} (source ${made.id})`);
        }
    }
    await waitSynced(ids, since);
}
async function check() {
    await waitHealthy();
    await signIn();
    const fail = [];
    const ver = await api('GET', '/api/version');
    console.log(`   version: ${ver.display}`);
    const ch = await api('GET', '/api/library/channels?limit=200');
    console.log(`   channels: ${ch.total}`);
    if (!ch.total) fail.push('no channels');
    const g = await api('GET', '/api/library/guide?limit=200');
    const withGuide = g.channels.filter(c => c.programmes && c.programmes.length);
    const progs = withGuide.reduce((n, c) => n + c.programmes.length, 0);
    console.log(`   guide (next 3 h): ${progs} programmes on ${withGuide.length} of ${g.channels.length} channels`);
    if (!progs) fail.push('empty guide');
    const ev = await api('GET', '/api/sports/events?hours=72');
    const live = ev.events.filter(e => e.live);
    console.log(`   sport events (72 h): ${ev.events.length}, live now ${live.length}: ${live.slice(0, 4).map(e => `${e.league} "${e.title}"`).join(', ')}`);
    if (!ev.events.length) fail.push('no sport events');
    const pick = ch.channels.find(c => /BBC ONE/.test(c.name)) || ch.channels.find(c => !/TEST|#/.test(c.name));
    if (!pick) { fail.push('no channel to play'); } else {
        const t0 = Date.now();
        const d = await api('POST', '/api/playback/resolve', { sourceId: pick.sourceId, channelId: pick.id,
            capabilities: { hls: true, fmp4: true, heaac: true, segmentedDelivery: true } });
        const url = d.playbackURL || d.url;
        console.log(`   play "${pick.name}": ${d.strategy} in ${Date.now() - t0} ms -> ${String(url).replace(/[?&]token=[^&]*/, '')}`);
        if (!/\.m3u8/.test(String(url))) fail.push('the play is not HLS');
        else {
            const abs = new URL(url, BASE);
            if (!abs.searchParams.has('token')) abs.searchParams.set('token', token);
            let text = await (await fetch(abs)).text();
            const variant = text.split('\n').find(l => l && !l.startsWith('#'));
            if (variant && /\.m3u8/.test(variant)) {
                const v = new URL(variant, abs); if (!v.searchParams.has('token')) v.searchParams.set('token', token);
                text = await (await fetch(v)).text(); abs.href = v.href;
            }
            const segs = text.split('\n').filter(l => l && !l.startsWith('#'));
            let bytes = 0;
            if (segs.length) {
                const s = new URL(segs[segs.length - 1], abs); if (!s.searchParams.has('token')) s.searchParams.set('token', token);
                const r = await fetch(s); bytes = (await r.arrayBuffer()).byteLength;
            }
            console.log(`   HLS: ${segs.length} segments listed, last one ${bytes} bytes`);
            if (!segs.length || !bytes) fail.push('no HLS segment');
        }
        if (d.sessionId) await api('DELETE', `/api/playback/${d.sessionId}`).catch(() => {});
    }
    if (fail.length) { console.log(`   CHECK FAILED: ${fail.join('; ')}`); process.exit(1); }
    console.log('   check passed');
}
(CFG.mode === 'seed' ? seed() : check()).catch(e => { console.error(`   ${e.message}`); process.exit(1); });
JS
    } | rsh "docker exec -i -u $RUNTIME_UID $STAGING node -"
}

fakes_json() {
    # The fakes' login is the made-up default of scripts/fake-provider.js, not a real account.
    printf '{"name":"Fake A","url":"http://%s:%s","user":"pigtv","pass":"fake"}' "$LAN_IP" "$FAKE_PORT"
    [ "$FAKE_B_PORT" = 0 ] || printf ',{"name":"Fake B","url":"http://%s:%s","user":"pigtv","pass":"fake"}' "$LAN_IP" "$FAKE_B_PORT"
}

seed() {
    if [ ! -f "$CREDS" ]; then
        mkdir -p "$(dirname "$CREDS")"
        ( umask 077; printf 'PIGTV_RIG_ADMIN_USER=rig-admin\nPIGTV_RIG_ADMIN_PASS=%s\n' "$(openssl rand -hex 16)" > "$CREDS" )
        echo "   new staging admin login written to $CREDS"
    fi
    say "seed staging (via localhost inside the container)"
    staging_node seed
}

cmd_check() {
    [ -f "$CREDS" ] || die "no $CREDS: run '$0 up' first"
    lan_ip
    say "check staging"
    staging_node check
}

# ------------------------------------------------------------------ test ---
cmd_test() {
    cmd_sync
    local key deps
    key="$(rsh "cat '$SRC/package-lock.json' | sha256sum | cut -c1-12")-$(rsh "docker image inspect -f '{{.Id}}' '$IMAGE' | cut -c8-19")"
    deps="$ROOT/runner/deps-$key"
    if ! rsh "test -d '$deps/node_modules'"; then
        say "install dependencies once into $deps (npm ci in the image's Node)"
        local t0=$SECONDS
        rsh "set -e; rm -rf '$deps.tmp'; mkdir -p '$deps.tmp'; chown $RUNTIME_UID '$deps.tmp'
             docker run --rm --name $RUNNER-deps ${CAPS[*]} --no-healthcheck --cpus 3 --memory 2g --user $RUNTIME_UID \
               -e HOME=/tmp -e npm_config_update_notifier=false \
               -v '$SRC/package.json':/in/package.json:ro -v '$SRC/package-lock.json':/in/package-lock.json:ro \
               -v '$deps.tmp':/out --entrypoint bash '$IMAGE' -c \
               'set -e; mkdir /tmp/b; cp /in/package*.json /tmp/b/; cd /tmp/b; npm ci --no-audit --no-fund --loglevel=warn; mv node_modules /out/ 2>/dev/null || cp -a node_modules /out/'
             find '$ROOT/runner' -maxdepth 1 -name 'deps-*' ! -name 'deps-$key*' -exec rm -rf {} +
             mv '$deps.tmp' '$deps'"
        echo "   installed in $((SECONDS - t0)) s"
    fi
    say "npm test (PIGTV_SKIP_PERF=1) and verify-build.sh in $RUNNER"
    local t0=$SECONDS rc=0
    rsh "docker rm -f $RUNNER >/dev/null 2>&1 || true
         docker run --rm --name $RUNNER ${CAPS[*]} --no-healthcheck --cpus 3 --memory 6g --user $RUNTIME_UID \
           -e HOME=/tmp -e npm_config_update_notifier=false -e PIGTV_SKIP_PERF=1 -v '$SRC':/work -v '$deps/node_modules':/work/node_modules:ro -w /work \
           --entrypoint bash '$IMAGE' -c '
             t=\$SECONDS; npm test > /tmp/test.log 2>&1; a=\$?
             tail -n 40 /tmp/test.log; echo \"== npm test exit \$a in \$((SECONDS - t)) s\"
             t=\$SECONDS; bash scripts/verify-build.sh . > /tmp/verify.log 2>&1; b=\$?
             tail -n 8 /tmp/verify.log; echo \"== verify-build exit \$b in \$((SECONDS - t)) s\"
             [ \$a = 0 ] || grep -E \"^not ok|# fail|failureType|Error\" /tmp/test.log | head -40
             mkdir -p /work/.rig-logs 2>/dev/null; cp /tmp/test.log /tmp/verify.log /work/.rig-logs/ 2>/dev/null
             [ \$a = 0 ] && [ \$b = 0 ]'" || rc=$?
    echo "== total $((SECONDS - t0)) s; full logs on the box in $SRC/.rig-logs/ (exit $rc)"
    return $rc
}

# ---------------------------------------------------------- status, down ---
cmd_status() {
    lan_ip
    rsh "docker ps -a --filter name=pigtv-test- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
         ids=\$(docker ps -q --filter name=pigtv-test-); [ -z \"\$ids\" ] || docker stats --no-stream \$ids
         echo; du -sh '$ROOT' 2>/dev/null; du -sh '$ROOT'/* 2>/dev/null
         echo; echo \"production $PROD (read only): \$(docker inspect -f '{{.State.Status}} since {{.State.StartedAt}} image {{.Image}}' $PROD 2>/dev/null | cut -c1-90)\""
    printf 'staging from here: '
    curl -s -m 5 "http://$LAN_IP:$PORT/api/version" || echo "(no answer at http://$LAN_IP:$PORT)"
    echo
}

cmd_down() {
    say "remove the rig's containers"
    rsh "docker rm -f $STAGING $FAKE_A $FAKE_B $RUNNER 2>/dev/null | sed 's/^/   removed /' || true"
}

cmd_reset() {
    cmd_down
    say "wipe staging data in $ROOT/staging"
    rsh "rm -rf '$ROOT/staging'"
    rm -f "$CREDS"
}

case "${1:-}" in
    sync) cmd_sync ;;
    up) cmd_up ;;
    check) cmd_check ;;
    status) cmd_status ;;
    test) cmd_test ;;
    down) cmd_down ;;
    reset) cmd_reset ;;
    *) sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
