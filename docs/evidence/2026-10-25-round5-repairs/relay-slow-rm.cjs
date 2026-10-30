// Mutation proof for the stream-relay test change: in a disposable copy of the working server, leg
// folder removal is delayed 200 ms (a loaded runner). The test file of `rev` (old: a 50 ms sleep;
// new: awaits filesRemoved()) is run against it. Usage: node relay-slow-rm.cjs <rev|WORKTREE>
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '../../../..'), rev = process.argv[2] || 'WORKTREE';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-relay-'));
try {
    fs.cpSync(path.join(root, 'server'), path.join(dir, 'server'), { recursive: true });
    const f = path.join(dir, 'server/services/streamRelay.js');
    const src = fs.readFileSync(f, 'utf8');
    const from = "leg.removing = fs.rm(leg.dir, { recursive: true, force: true })";
    if (!src.includes(from)) throw new Error('streamRelay.js does not have the expected removal line');
    fs.writeFileSync(f, src.replace(from, "leg.removing = new Promise(r => setTimeout(r, 200)).then(() => fs.rm(leg.dir, { recursive: true, force: true }))"));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'test'));
    const test = rev === 'WORKTREE' ? fs.readFileSync(path.join(root, 'test/stream-relay.test.js'), 'utf8')
        : cp.execFileSync('git', ['show', `${rev}:test/stream-relay.test.js`], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'test/stream-relay.test.js'), test);
    for (const h of fs.readdirSync(path.join(root, 'test')).filter(n => !n.endsWith('.test.js'))) fs.cpSync(path.join(root, 'test', h), path.join(dir, 'test', h), { recursive: true });
    const r = cp.spawnSync(process.execPath, ['--test', '--test-timeout=25000', path.join(dir, 'test/stream-relay.test.js')], { encoding: 'utf8', timeout: 60000, cwd: dir });
    process.stdout.write(`# stream-relay test of ${rev}, removal delayed 200 ms\n${r.stdout || ''}`); process.stderr.write(r.stderr || '');
    process.exitCode = r.status ?? 1;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
