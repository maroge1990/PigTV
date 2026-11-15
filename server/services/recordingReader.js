/**
 * #318: a recording's bytes on the share, for playback (/stream, media.mp4) and a download, read by a short-lived child
 * process (recordingReaderChild.js) and piped to the response, never by the server process. An fs read on a share that
 * hangs mid-stream holds one of libuv's four pool threads until the mount answers; four such requests took every fs,
 * dns and zlib call the server makes, live TV included. The child is killed when the response closes or finishes, and
 * when no bytes have come from it for `stallMs` while the response was ready for more (a player that stops reading is
 * not a stalled share); the response is then destroyed, or answered 503 when nothing of it was sent yet.
 */
const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'recordingReaderChild.js');
const tuning = { stallMs: 20000 }; // a test may shorten it
const live = new Set(); // the children not yet exited (tests: none left behind)

const unresponsive = () => Object.assign(new Error('The recordings folder is not responding'), { code: 'SHARE_UNRESPONSIVE' });

/**
 * Bytes `start`..`end` (inclusive) of `file` to `res`, whose status and headers the caller has set. Resolves once the
 * response has them all or was closed by the client (a seek); rejects, with nothing sent, when the child cannot read the
 * file (or SHARE_UNRESPONSIVE when the share gave nothing before the stall time), so the caller answers as before.
 */
function pipeRange(file, start, end, res) {
    return new Promise((resolve, reject) => {
        const expected = end - start + 1;
        let child;
        try {
            child = spawn(process.execPath, [CHILD, String(file), String(start), String(end)], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (err) {
            return reject(err);
        }
        live.add(child);
        child.on('exit', () => live.delete(child));
        let got = 0, done = false, timer = null;
        const kill = () => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } };
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            res.off('close', onClose);
            res.off('drain', onDrain);
            kill();
            if (!err) return resolve();
            if (got === 0 && !res.headersSent) return reject(err);
            res.destroy(); // part of it is out: the player sees a cut connection, as on a read error before
            resolve();
        };
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                console.warn(`[Recordings] The share sent nothing for ${Math.round(tuning.stallMs / 1000)} s; the read is stopped`);
                finish(unresponsive());
            }, tuning.stallMs);
        };
        const onClose = () => finish(); // the client went (a seek, a closed player): ordinary
        const onDrain = () => { if (!done) { child.stdout.resume(); arm(); } };
        res.on('close', onClose);
        res.on('drain', onDrain);
        child.on('error', (err) => finish(err));
        child.stdout.on('data', (chunk) => {
            if (done) return;
            got += chunk.length;
            if (res.write(chunk)) { arm(); return; }
            clearTimeout(timer); // the client is slow to read, not the share
            child.stdout.pause();
        });
        child.on('close', (code) => {
            if (done) return;
            if (code === 0 && got === expected) {
                done = true;
                clearTimeout(timer);
                res.off('close', onClose);
                res.off('drain', onDrain);
                res.end();
                resolve();
                return;
            }
            finish(Object.assign(new Error(code === 2 ? 'Recording file could not be read' : 'Recording read stopped'), { code: 'READ_FAILED' }));
        });
        arm();
    });
}

module.exports = { pipeRange, tuning, _live: live };
