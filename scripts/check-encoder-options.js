#!/usr/bin/env node
// Validate the actual session builders against each encoder's own help, then run
// software encode variants. This never opens a provider or a hardware device.
const { spawnSync } = require('node:child_process');
const { TranscodeSession } = require('../server/services/transcodeSession');
const generic = new Set(['fps_mode', 'vf', 'c', 'profile', 'level', 'pix_fmt', 'bf', 'global_quality', 'force_key_frames']);
function optionNames(help) { return new Set([...help.matchAll(/^\s+-([\w-]+)(?:[:\w]*)\s/gm)].map(m => m[1])); }
function privateOptions(args) {
    return args.filter((_, i) => i % 2 === 0).map(v => v.slice(1).split(':')[0]).filter(v => !generic.has(v));
}
function validate(args, help, encoder) {
    const names = optionNames(help), missing = privateOptions(args).filter(n => !names.has(n));
    if (missing.length) throw new Error(`${encoder} does not support builder option(s): ${missing.join(', ')}`);
}
function run(binary = 'ffmpeg', softwareOnly = false) {
    const invoke = args => {
        const r = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
        if (r.error || r.status !== 0) throw new Error(`ffmpeg encoder check failed: ${r.error?.code || r.status}`);
        return r.stdout;
    };
    const encoders = new Set(invoke(['-hide_banner', '-encoders']).split(/\s+/));
    for (const mode of ['software', ...(softwareOnly ? [] : ['nvenc', 'vaapi', 'qsv', 'amf'])]) {
        if (mode === 'amf' && !encoders.has('h264_amf')) { console.log('AMF unavailable in this build (also absent in the deployed Ubuntu profile); options not checked'); continue; }
        for (const quality of ['low', 'medium', 'high']) {
            const session = new TranscodeSession('http://offline.invalid/unused', { hwEncoder: mode, quality, maxResolution: '480p', live: true });
            const args = []; session.addVideoEncoderArgs(args, mode);
            const encoder = args[args.indexOf('-c:v') + 1];
            if (!encoders.has(encoder)) {
                throw new Error(`Required encoder missing: ${encoder}`);
            }
            validate(args, invoke(['-hide_banner', '-h', `encoder=${encoder}`]), encoder);
            if (mode === 'software') invoke(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '1', ...args, '-an', '-f', 'null', '-']);
        }
        console.log(`${mode}: builder options checked${mode === 'software' ? ', three real encodes passed' : ''}`);
    }
}
module.exports = { optionNames, privateOptions, validate, run };
if (require.main === module) {
    try { run(process.argv.find(a => a.startsWith('--ffmpeg='))?.slice(9), process.argv.includes('--software-only')); }
    catch (err) { console.error(err.message); process.exitCode = 1; }
}
