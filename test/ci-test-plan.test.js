const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ALWAYS_RUN, plan, isSafe, ffmpegTestFiles, testFiles, SAFE_PATHS } = require('../scripts/ci-test-plan');

// D-50: a push on safe paths skips the ffmpeg test files; anything else runs everything.
const root = path.join(__dirname, '..');
const ffmpeg = ffmpegTestFiles(root).map((f) => 'test/' + f);
const OK = { baseImageExists: true };

// Pinned: a file entering this list is a reviewed change, and a wrong one fails here.
const EXPECTED_SKIP = [
    'test/hls-copy-dts.test.js',
    'test/hls-finite-source.test.js',
    'test/hls-timestamp-skew.test.js',
    'test/logo-alpha.test.js',
    'test/recording-codec-probe.test.js',
    'test/recording-segments-media.test.js',
    'test/shared-session-accounting.test.js',
];

test('the skip set is exactly the pinned list', () => {
    assert.deepEqual(ffmpeg, EXPECTED_SKIP);
});

test('a test that gates itself on ffmpeg is classified, or always runs', () => {
    const gated = testFiles(root).filter((f) => {
        if (ALWAYS_RUN.includes(f)) return false;
        const text = fs.readFileSync(path.join(root, 'test', f), 'utf8');
        return /(?:hasFf|haveFf)mpeg\b|toolsOk\b/.test(text) || /skip[^\n]*ffmpeg/i.test(text);
    });
    for (const f of gated) assert.ok(ffmpeg.includes('test/' + f), `${f} skips without ffmpeg but is not classified as needing it`);
});

test('a sport-only or web-only push skips the ffmpeg files and runs the rest', () => {
    for (const files of [['public/js/pages/Sports.js', 'public/css/app.css', 'server/version.js'],
        ['test/sport-front.test.js', 'docs/DESIGN.md', 'ROADMAP.md']]) {
        const p = plan(files, root, OK);
        assert.equal(p.mode, 'partial');
        assert.deepEqual(p.skipped, EXPECTED_SKIP);
        assert.equal(p.run.length + p.skipped.length, testFiles(root).length);
        assert.ok(p.run.includes('test/api-404.test.js'));
        for (const f of ALWAYS_RUN) assert.ok(p.run.includes('test/' + f), f);
    }
});

test('server code is never safe, even a sport file', () => {
    for (const f of ['server/services/sportFront.js', 'server/routes/sports.js', 'server/services/sportsEvents.js']) {
        assert.equal(plan(['public/js/app.js', f], root, OK).mode, 'full', f);
    }
});

test('a playback or shared change runs the full suite', () => {
    for (const f of ['server/services/playbackStrategy.js', 'server/db.js', 'server/auth.js', 'package.json', 'Dockerfile',
        '.github/workflows/test.yml', 'scripts/verify-build.sh', 'test/helpers/server.js', 'public/img/logo.png',
        'server/routes/playback.js', 'server/services/streamCoordinator.js']) {
        const p = plan(['public/js/app.js', f], root, OK);
        assert.equal(p.mode, 'full', f);
        assert.deepEqual(p.skipped, [], f);
        assert.equal(p.run.length, testFiles(root).length, f);
    }
});

test('it fails open: unknown, empty or failed diff, force push, other events, no base image', () => {
    const safe = ['public/js/app.js'];
    assert.equal(plan(null, root, OK).mode, 'full');
    assert.equal(plan([], root, OK).mode, 'full');
    assert.equal(plan(undefined, root, OK).mode, 'full');
    assert.equal(plan(safe, root, { ...OK, forced: true }).mode, 'full');
    assert.equal(plan(safe, root, { ...OK, event: 'workflow_dispatch' }).mode, 'full');
    assert.equal(plan(['public/js/app.js', 'something/new.txt'], root, OK).mode, 'full');
    assert.equal(plan(['public/js/../../server/db.js'], root, OK).mode, 'full');
    assert.equal(plan(['/etc/passwd', ''], root, OK).mode, 'full');
    assert.equal(plan(safe, root, { ...OK, event: 'push' }).mode, 'partial');
});

test('a base commit with no published image means the full suite (a red or cancelled earlier push)', () => {
    assert.equal(plan(['public/js/app.js'], root).mode, 'full');
    assert.equal(plan(['public/js/app.js'], root, { baseImageExists: false }).mode, 'full');
    assert.match(plan(['public/js/app.js'], root).reason, /no published image/);
});

test('a changed ffmpeg test file still runs; a name needing quoting means the full suite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-plan-'));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test/sport-real.test.js'), "spawnSync('ff" + "mpeg', ['-version'])\n");
    fs.writeFileSync(path.join(dir, 'test/plain.test.js'), '// nothing\n');
    assert.deepEqual(plan(['public/js/a.js'], dir, OK).skipped, ['test/sport-real.test.js']);
    const p = plan(['test/sport-real.test.js'], dir, OK);
    assert.equal(p.mode, 'partial');
    assert.deepEqual(p.skipped, []);
    fs.writeFileSync(path.join(dir, 'test/odd name.test.js'), '// x\n');
    assert.equal(plan(['public/js/a.js'], dir, OK).mode, 'full');
});

// Every .js under server/ that a file outside the safe list requires must itself be off the safe list.
test('no server file outside the safe list requires a safe-listed server file', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const files = walk(path.join(root, 'server')).map((f) => path.relative(root, f).split(path.sep).join('/'));
    const bad = [];
    for (const f of files) {
        if (isSafe(f)) continue;
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        for (const m of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
            const hit = [base, base + '.js', base + '/index.js'].find((c) => files.includes(c));
            // server/version.js is the one deliberate exception: a build-number bump, read at db open.
            if (hit && hit !== 'server/version.js' && isSafe(hit)) bad.push(`${f} requires ${hit}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('the safe list is short and holds no shared code', () => {
    assert.ok(SAFE_PATHS.length <= 15);
    for (const bad of ['server/db', 'server/auth', 'server/index', 'server/services', 'server/routes', 'scripts', '.github', 'Dockerfile', 'package', 'test/helpers', 'public/img']) {
        assert.ok(!SAFE_PATHS.some((p) => p.startsWith(bad)), bad);
    }
    assert.ok(!isSafe('server/services/channelLinks.js'));
});
