const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Fail closed on version drift, incomplete hardware builds and tampered downloads.
// No system binaries, network, GPU or source compiler needed for these failure cases.
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-media-contract-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const names = {
    '-encoders': 'libx264 libx265 aac libmp3lame h264_vaapi hevc_vaapi h264_nvenc hevc_nvenc h264_qsv hevc_qsv',
    '-decoders': 'h264 hevc aac ac3 eac3 h264_cuvid hevc_cuvid libdav1d',
    '-buildconf': '--enable-libvpl --enable-libdav1d --enable-libxml2 --enable-iconv',
    '-demuxers': 'dash hls mov,mp4,m4a,3gp,3g2,mj2 mpegts',
    '-protocols': 'http https tcp udp rtp srt',
    '-filters': 'scale bwdif yadif aresample scale_vaapi scale_cuda scale_qsv hwupload hwdownload'
};
for (const tool of ['ffmpeg', 'ffprobe']) {
    fs.writeFileSync(path.join(tmp, tool), `#!${process.execPath}
const lists = ${JSON.stringify(names)};
if (process.argv.includes('-version')) console.log('${tool} version ' + (process.env.TEST_${tool.toUpperCase()}_RELEASE || '9.0.2'));
else {
 const value = lists[process.argv.at(-1)];
 if (!value) process.exit(77); // a capability check must never try to open a GPU/feed
 console.log(value.split(' ').filter(n => n !== process.env.TEST_MEDIA_OMIT).join(' '));
}
`);
    fs.chmodSync(path.join(tmp, tool), 0o755);
}
const check = (env = {}, hardware = true) => spawnSync(process.execPath, [path.join(root, 'scripts/check-media-tools.js'),
    `--ffmpeg=${path.join(tmp, 'ffmpeg')}`, `--ffprobe=${path.join(tmp, 'ffprobe')}`, ...(hardware ? ['--hardware'] : [])],
{ encoding: 'utf8', env: { ...process.env, ...env } });

test('the pinned release with every production capability passes without opening a device', () => {
    const r = check(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /capabilities OK/);
});
for (const tool of ['FFMPEG', 'FFPROBE']) test(`a drifted ${tool} release is rejected, even when all features exist`, () => {
    const r = check({ [`TEST_${tool}_RELEASE`]: '6.1.1' });
    assert.equal(r.status, 1); assert.match(r.stderr, /Expected .*9\.0\.2/);
});
test('a prefix match cannot silently accept another patch release', () => {
    const r = check({ TEST_FFMPEG_RELEASE: '9.0.20' }); assert.equal(r.status, 1); assert.match(r.stderr, /Expected ffmpeg/);
});
for (const missing of ['hevc_nvenc', 'scale_cuda', 'h264_qsv', 'https', 'h264_cuvid', '--enable-libvpl']) test(`missing ${missing} blocks the production build`, () => {
    const r = check({ TEST_MEDIA_OMIT: missing }); assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(missing));
});
test('local software validation permits a platform without Linux hardware filters', () => {
    const r = check({ TEST_MEDIA_OMIT: 'scale_cuda' }, false); assert.equal(r.status, 0, r.stderr);
});
test('source hashes are verified for both cached archives, not trusted merely because a cache exists', () => {
    const dir = path.join(tmp, 'build'); fs.mkdirSync(dir);
    fs.copyFileSync(path.join(root, 'docker/build-media-tools.sh'), path.join(dir, 'build-media-tools.sh'));
    const ff = Buffer.from('synthetic ffmpeg archive'), nv = Buffer.from('synthetic header archive');
    const digest = b => crypto.createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(path.join(dir, 'media-toolchain.conf'), `FFMPEG_RELEASE=9.0.2\nFFMPEG_SHA256=${digest(ff)}\nNV_CODEC_RELEASE=11.1.5.3\nNV_CODEC_SHA256=${digest(nv)}\n`);
    const ffPath = path.join(dir, 'ffmpeg-9.0.2.tar.xz'), nvPath = path.join(dir, 'nv-codec-headers-11.1.5.3.tar.gz');
    fs.writeFileSync(ffPath, ff); fs.writeFileSync(nvPath, nv);
    const verify = () => spawnSync('bash', [path.join(dir, 'build-media-tools.sh'), '--verify-only'],
        { encoding: 'utf8', env: { ...process.env, MEDIA_DOWNLOAD_DIR: dir } });
    assert.equal(verify().status, 0, 'both cache files verified');
    const unsafePrefix = spawnSync('bash', [path.join(dir, 'build-media-tools.sh'), dir],
        { encoding: 'utf8', env: { ...process.env, MEDIA_DOWNLOAD_DIR: dir } });
    assert.equal(unsafePrefix.status, 1);
    assert.match(unsafePrefix.stderr, /new or empty absolute directory/);
    assert.deepEqual(fs.readFileSync(ffPath), ff, 'never clean an existing shared install directory');
    for (const [file, original] of [[ffPath, ff], [nvPath, nv]]) {
        fs.writeFileSync(file, 'tampered');
        const r = verify(); assert.equal(r.status, 1); assert.match(r.stderr, /Checksum mismatch/);
        fs.writeFileSync(file, original);
    }
});


test('R1-M4: private builder options must exist on their own encoder, not merely another encoder', () => {
    const { validate } = require('../scripts/check-encoder-options');
    const args = ['-c:v', 'h264_qsv', '-look_ahead', '1', '-look_ahead_depth', '40'];
    assert.throws(() => validate(args, '  -preset <int>\n', 'h264_qsv'), /look_ahead/);
    assert.doesNotThrow(() => validate(args, '  -look_ahead <boolean>\n  -look_ahead_depth <int>\n', 'h264_qsv'));
});

test('R1-L5: bundled version mismatch is reported without echoing tool text or paths', () => {
    const { inspect } = require('../server/services/mediaToolVersions');
    const report = inspect({ ffmpeg: '/x/node_modules/ffmpeg-static/ffmpeg', ffprobe: '/x/node_modules/@ffprobe-installer/ffprobe' },
        file => ({ status: 0, stdout: file.includes('ffmpeg-static') ? 'ffmpeg version 6.0 release https://secret.invalid/password' : 'ffprobe version n4.4.1 release' }));
    assert.equal(report.ffmpeg.version, '6.0'); assert.equal(report.ffprobe.version, '4.4.1');
    assert.equal(report.ffmpeg.origin, 'bundled'); assert.equal(report.mismatch, true);
    assert.ok(!JSON.stringify(report).includes('secret'));
    assert.ok(!JSON.stringify(report).includes('/x/'));
});
