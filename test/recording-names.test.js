const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// TZ is read when the process starts, so each zone runs in its own child.
const module_ = path.join(__dirname, '../server/services/recordingNames.js');
function stamp(iso, tz) {
    return execFileSync(process.execPath, ['-e',
        `process.stdout.write(require(${JSON.stringify(module_)}).formatLocalStamp(new Date(${JSON.stringify(iso)})))`],
        { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
}

test('a container with no TZ files a recording under UTC, which is the surprise TZ fixes', () => {
    assert.equal(stamp('2026-09-19T09:30:00Z', 'UTC'), '2026-09-19 09-30');
});

test('with TZ set, the file name carries the local time of the programme', () => {
    // Sydney is UTC+10 in September, before daylight saving starts in October.
    assert.equal(stamp('2026-09-19T09:30:00Z', 'Australia/Sydney'), '2026-09-19 19-30');
});

test('daylight saving and day rollover are handled by the zone, not by us', () => {
    assert.equal(stamp('2026-10-10T09:30:00Z', 'Australia/Sydney'), '2026-10-10 20-30', 'UTC+11 after the October changeover');
    assert.equal(stamp('2026-09-19T20:00:00Z', 'Australia/Sydney'), '2026-09-20 06-00', 'rolls into the next local day');
});

test('an epoch-millisecond start time is accepted, as the scheduler stores it', () => {
    const { formatLocalStamp } = require('../server/services/recordingNames');
    const ms = Date.UTC(2026, 8, 19, 9, 30);
    assert.equal(formatLocalStamp(ms), formatLocalStamp(new Date(ms)));
    assert.match(formatLocalStamp(ms), /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}$/);
});
