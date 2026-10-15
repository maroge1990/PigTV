// The real server (server/index.js) as a child process, for the tests that need what index.js
// itself does (mounts, ordering, headers). One way to start it, so none of them can pass while
// the server never came up, or fail with nothing but "fetch failed" when it didn't.
const net = require('node:net');
const { spawn } = require('node:child_process');

const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
    probe.on('error', reject);
});

// What server/index.js prints once it has bound its port, and when another process holds it.
const LISTENING = /PigTV server running on http:\/\/localhost:(\d+)/;
const PORT_IN_USE = /Could not listen on port \d+:.*(?:EADDRINUSE|address already in use)/i;
const ATTEMPTS = 3;

/**
 * Start server/index.js in `cwd` (a sandbox copy that has server/, package.json and
 * node_modules). Resolves { base, child, output() } once /api/version answers AND the child has
 * said it is listening on that port; rejects with the server's own last output if it exits or
 * has not answered within `timeoutMs`.
 *
 * freePort() closes its probe before the child binds, so on a loaded CI box another test's
 * server can take the port in between. That shows up two ways, and both are handled: the child
 * exits with "Could not listen ... EADDRINUSE" (retried on a new port, up to ATTEMPTS times; any
 * other exit is a real failure and is not retried), or /api/version is answered by the OTHER
 * server, which is why an answer only counts once this child has printed its own listening line.
 * `port` forces the first attempt's port (tests of this helper).
 */
async function startServer({ cwd, env = {}, timeoutMs = 60000, port: firstPort } = {}) {
    let lastOutput = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const port = attempt === 1 && firstPort ? firstPort : await freePort();
        const result = await startOnce({ cwd, env, timeoutMs, port });
        if (result.server) return result.server;
        lastOutput = result.output;
        if (!result.portInUse) throw result.error;
    }
    throw new Error(`the server could not get a free port in ${ATTEMPTS} attempts:\n${lastOutput}`);
}

async function startOnce({ cwd, env, timeoutMs, port }) {
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, PORT: String(port) }
    });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const closed = new Promise(r => child.once('close', r));
    const ours = () => { const m = out.match(LISTENING); return m && Number(m[1]) === port; };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && child.exitCode === null) {
        if (ours()) {
            try { if ((await fetch(`${base}/api/version`)).ok) return { server: { base, child, output: () => out } }; } catch { /* not up yet */ }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    if (child.exitCode === null) { child.kill(); }
    else { await Promise.race([closed, new Promise(r => setTimeout(r, 500))]); } // let the last output arrive
    return {
        portInUse: child.exitCode !== null && PORT_IN_USE.test(out),
        output: out,
        error: new Error(`the server never answered on ${base} (exit ${child.exitCode}):\n${out}`)
    };
}

/** Stop a server startServer started (waits up to 3 s for it to exit). */
async function stopServer(server) {
    if (!server || !server.child || server.child.exitCode !== null) return;
    server.child.kill();
    await new Promise(r => { server.child.once('exit', r); setTimeout(r, 3000); });
}

module.exports = { startServer, stopServer, freePort };
