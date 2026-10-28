// Bounded, URL-free tool identity for startup logs and Status. No feed is opened.
const { spawnSync } = require('node:child_process');
function inspect(paths, exec = spawnSync) {
    const result = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
        const file = paths[tool];
        const origin = !file ? 'unavailable' : file === tool ? 'system'
            : /ffmpeg-static|@ffprobe-installer/.test(file) ? 'bundled' : 'custom';
        let version = null;
        if (file) {
            let r;
            try { r = exec(file, ['-version'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }); } catch { r = { status: -1 }; }
            if (!r.error && r.status === 0) version = new RegExp(`^${tool} version n?(\\d+(?:\\.\\d+){1,2})(?:[ +\\-]|$)`).exec(r.stdout || '')?.[1] || null;
        }
        result[tool] = { version, origin };
    }
    result.mismatch = !!result.ffmpeg.version && !!result.ffprobe.version && result.ffmpeg.version !== result.ffprobe.version;
    return result;
}
module.exports = { inspect };
