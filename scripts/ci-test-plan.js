#!/usr/bin/env node
// Which test files a push has to run (D-50). One decision, in one place, runnable dry:
//
//   node scripts/ci-test-plan.js --files public/js/pages/Sports.js server/services/sportFront.js
//   node scripts/ci-test-plan.js --base <sha> --head <sha> [--forced true] [--event push] [--base-image-exists true]
// (without --base-image-exists true the plan is the full suite; --files runs also need it for a partial result)
//   ... add --format github to print mode=/files=/reason= lines for $GITHUB_OUTPUT
//
// The suite runs once per push, inside the candidate image (docker-publish.yml). A push whose changed
// files are ALL on SAFE_PATHS (sport-only or web-only) skips the test files that need the real ffmpeg.
// Everything else runs the full suite, and so does anything this script cannot judge: it FAILS OPEN
// (unknown path, empty or failed diff, force push, first push, any event but push, any error).
// release.yml never asks this script: a release runs the full suite.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The only list of safe paths. '/' at the end = everything under that folder; '*' matches within one
// path segment. Shared code is never listed: db, auth, settings, routes playback or recording use,
// package files, Dockerfile, workflows, scripts, test helpers, public/img (logo tests read it).
const SAFE_PATHS = [
    'public/js/',
    'public/css/',
    'public/index.html',
    'public/login.html',
    // No server/ code but the build number: every sport file is required by server/index.js, the
    // recording engine or the sync, so none is sport-only (test/ci-test-plan.test.js walks the requires).
    'server/version.js',          // every functional commit bumps it; db/sqlite.js reads it
    'test/sport*.test.js',
    'test/web-*.test.js',
    'docs/',
    '*.md',
];

// A test file "needs ffmpeg" when it runs the real binary: it spawns ffmpeg or ffprobe by name, or
// gates a test on their being installed. Derived from the files, so a new one is found. Files that
// only name ffmpeg (stand-ins, constants, comments, log samples) do not match.
const NEEDS_FFMPEG = /spawn(?:Sync)?\(\s*['"`](?:ffmpeg|ffprobe)|\b(?:hasFfmpeg|haveFfmpeg|toolsOk)\b|skip[^\n]*ffmpeg/i;

// Needs ffmpeg for a few cases but mostly protects something else, so a sport or web push still
// runs it (its ffmpeg cases skip themselves when the binary is missing): contract-golden is the client contract.
// Likewise fake-provider (end-to-end sport events and sync), stream-doctor (redaction) and logo-sizes (SVG limits):
// each holds tests that need no ffmpeg, and skipping is per file, not per test.
const ALWAYS_RUN = ['contract-golden.test.js', 'fake-provider.test.js', 'stream-doctor.test.js', 'logo-sizes.test.js',
    'ci-test-plan.test.js'];   // the last only names the binary

function testFiles(root) {
    return fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).sort();
}

function ffmpegTestFiles(root) {
    return testFiles(root).filter((f) => !ALWAYS_RUN.includes(f) && NEEDS_FFMPEG.test(fs.readFileSync(path.join(root, 'test', f), 'utf8')));
}

function matches(pattern, file) {
    if (pattern.endsWith('/')) return file.startsWith(pattern);
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    return re.test(file);
}

function isSafe(file) {
    if (typeof file !== 'string' || !file || file.includes('..') || file.startsWith('/')) return false;
    return SAFE_PATHS.some((p) => matches(p, file));
}

// changed: array of paths, or null when the diff could not be had. Returns { mode, reason, run, skipped }.
function plan(changed, root = path.join(__dirname, '..'), opts = {}) {
    const all = testFiles(root).map((f) => 'test/' + f);
    const full = (reason) => ({ mode: 'full', reason, run: all, skipped: [] });
    if (opts.event && opts.event !== 'push') return full(`event ${opts.event}`);
    if (opts.forced) return full('force push');
    // The commit this push diffs from must have passed the full gate (it has a published image); else a red
    // earlier push could ride through on a later safe one.
    if (!opts.baseImageExists) return full('the base commit has no published image');
    if (!Array.isArray(changed) || changed.length === 0) return full('no usable list of changed files');
    // The workflow passes the list on a command line; a name it would split or expand is not judged.
    if (all.some((f) => !/^[A-Za-z0-9._\/-]+$/.test(f))) return full('a test file name needs quoting');
    const unsafe = changed.filter((f) => !isSafe(f));
    if (unsafe.length) return full(`not on the safe list: ${unsafe.slice(0, 5).join(', ')}${unsafe.length > 5 ? ', ...' : ''}`);
    const skip = new Set(ffmpegTestFiles(root).map((f) => 'test/' + f));
    // A changed ffmpeg test file is itself a reason to run it.
    const changedSet = new Set(changed);
    const skipped = all.filter((f) => skip.has(f) && !changedSet.has(f));
    return {
        mode: 'partial',
        reason: 'every changed file is on the safe list',
        run: all.filter((f) => !skipped.includes(f)),
        skipped,
    };
}

function gitChanged(base, head, root) {
    if (!base || !head || /^0+$/.test(base)) return null;           // first push or unknown
    try {
        const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}`, `${head}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.split('\n').filter(Boolean);
    } catch { return null; }
}

function arg(argv, name) {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
}

function main(argv) {
    const root = path.join(__dirname, '..');
    let result;
    try {
        let changed;
        const fi = argv.indexOf('--files');
        if (fi >= 0) {
            const rest = argv.slice(fi + 1);
            const end = rest.findIndex((a) => a.startsWith('--'));
            changed = end < 0 ? rest : rest.slice(0, end);
        }
        else changed = gitChanged(arg(argv, '--base'), arg(argv, '--head'), root);
        result = plan(changed, root, { event: arg(argv, '--event'), forced: arg(argv, '--forced') === 'true', baseImageExists: arg(argv, '--base-image-exists') === 'true' });
    } catch (err) {
        const all = testFiles(root).map((f) => 'test/' + f);
        result = { mode: 'full', reason: `error: ${err.message}`, run: all, skipped: [] };
    }
    if (arg(argv, '--format') === 'github') {
        // Full = empty file list: the workflow then runs `npm test`.
        console.log(`mode=${result.mode}`);
        console.log(`reason=${result.reason}`);
        console.log(`files=${result.mode === 'full' ? '' : result.run.join(' ')}`);
    } else {
        console.log(`mode: ${result.mode} (${result.reason})`);
        console.log(`run ${result.run.length} test files, skip ${result.skipped.length}`);
        for (const f of result.skipped) console.log(`  skipped: ${f}`);
    }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { SAFE_PATHS, ALWAYS_RUN, NEEDS_FFMPEG, plan, isSafe, ffmpegTestFiles, testFiles };
