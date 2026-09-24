const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const tuner = require('../server/services/tuner');

// 0132: timeshift can live on a local disk when the recordings volume is a
// network share.
test('timeshift defaults to <recordings>/.timeshift', () => {
    delete process.env.PIGTV_TIMESHIFT_DIR;
    assert.strictEqual(tuner.timeshiftBase('/rec'), path.join('/rec', '.timeshift'));
});

test('PIGTV_TIMESHIFT_DIR overrides it', () => {
    process.env.PIGTV_TIMESHIFT_DIR = '/app/data/timeshift';
    try {
        assert.strictEqual(tuner.timeshiftBase('/rec'), '/app/data/timeshift');
    } finally {
        delete process.env.PIGTV_TIMESHIFT_DIR;
    }
});
