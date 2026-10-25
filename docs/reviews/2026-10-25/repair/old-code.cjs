// Run one current test file against an older server revision, in a disposable copy (never the
// working checkout), with bounded test and process time. Usage, under Node 24:
//   node docs/reviews/2026-10-25/repair/old-code.cjs <revision> <test file> [name pattern]
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const [rev, file, pattern] = process.argv.slice(2);
if (!rev || !file) { console.error('usage: old-code.cjs <revision> <test file> [pattern]'); process.exit(2); }
const root = path.resolve(__dirname, '../../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-old-'));
try {
    cp.execFileSync('tar', ['-x', '-C', dir], { input: cp.execFileSync('git', ['archive', rev, 'server'], { cwd: root, maxBuffer: 50e6 }) });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    fs.cpSync(path.join(root, 'test'), path.join(dir, 'test'), { recursive: true });
    const args = ['--test', '--test-timeout=25000', ...(pattern ? ['--test-name-pattern=' + pattern] : []), path.join(dir, file)];
    const r = cp.spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, cwd: dir });
    process.stdout.write(`# revision ${rev}, ${file}${pattern ? `, /${pattern}/` : ''}\n`);
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    process.exitCode = r.status ?? 1;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
