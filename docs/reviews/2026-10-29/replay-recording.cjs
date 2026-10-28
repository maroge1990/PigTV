// Offline only. From the repo root: node docs/reviews/2026-10-29/replay-recording.cjs
// Raw evidence must be present in the ignored data/samples/2026-10-29-rec203/e1 folder.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const segments = require('../../../server/services/recordingSegments');
const { parseMediaPlaylist, renderMediaPlaylist } = require('../../../server/services/hlsPlaylist');
const root = path.resolve(__dirname, '../../../data/samples/2026-10-29-rec203');
const source = path.join(root, 'e1');
const archive = parseMediaPlaylist(fs.readFileSync(path.join(source, 'archive.m3u8'), 'utf8'));
const available = archive.segments.filter(s => fs.existsSync(path.join(source, s.name)));
if (available.length !== 3) throw Error('Expected the three preserved raw segments');
for (const mode of ['before', 'after']) {
    const dir = path.join(root, mode, 'e1');
    fs.mkdirSync(dir, { recursive: true });
    for (const s of available) fs.copyFileSync(path.join(source, s.name), path.join(dir, s.name));
    fs.writeFileSync(path.join(dir, 'archive.m3u8'), renderMediaPlaylist({
        segments: available, mediaSequence: 0, version: 3, playlistType: 'EVENT', endList: true,
        independentSegments: true
    }).text);
    const args = segments.viewArgs(dir, { video: 'hevc', audio: 'aac' });
    if (mode === 'before') args.splice(args.indexOf('-bsf:a'), 2);
    const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    fs.writeFileSync(path.join(root, mode, 'ffmpeg.txt'), result.stderr || '');
    console.log(mode, 'exit', result.status);
    console.log(fs.readFileSync(path.join(dir, 'view.m3u8'), 'utf8'));
    if (mode === 'before' && result.status === 0) throw Error('Baseline no longer reproduces');
    if (mode === 'after' && result.status !== 0) throw Error('Patched remux failed');
}
