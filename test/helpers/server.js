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

/**
 * Start server/index.js in `cwd` (a sandbox copy that has server/, package.json and
 * node_modules). Resolves { base, child, output() } once /api/version answers; rejects with
 * the server's own last output if it exits or has not answered within `timeoutMs`.
 */
async function startServer({ cwd, env = {}, timeoutMs = 60000 }) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, PORT: String(port) }
    });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && child.exitCode === null) {
        try { if ((await fetch(`${base}/api/version`)).ok) return { base, child, output: () => out }; } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    child.kill();
    throw new Error(`the server never answered on ${base} (exit ${child.exitCode}):\n${out}`);
}

/** Stop a server startServer started (waits up to 3 s for it to exit). */
async function stopServer(server) {
    if (!server || !server.child || server.child.exitCode !== null) return;
    server.child.kill();
    await new Promise(r => { server.child.once('exit', r); setTimeout(r, 3000); });
}

module.exports = { startServer, stopServer, freePort };
