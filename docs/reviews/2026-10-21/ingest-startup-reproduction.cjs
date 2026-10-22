// Review evidence: asserts the defect as observed on 0226, not desired behaviour.
// No sockets, database, ffmpeg or provider connection. Run from the repository root.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
let request;
const http = { get() {
    request = new EventEmitter();
    request.setTimeout = ms => { request.timeout = ms; };
    request.destroy = () => {};
    return request;
} };
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync('server/services/ingest.js', 'utf8'), {
    require: name => name === 'http' ? http : require(name), module: mod,
    console, process, Buffer, setInterval, clearInterval, setTimeout, clearTimeout, URL
});
const ingest = mod.exports;
(async () => {
    let settled = false;
    ingest.subscribe({ pool: 'review', url: 'http://localhost/silent' }).then(
        () => { settled = true; }, () => { settled = true; });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    response.destroy = () => {};
    request.emit('response', response);
    const reader = [...ingest._registry.values()][0];
    reader.startedAt -= 60000;
    reader.checkStall();
    assert.equal(request.timeout, 0);
    assert.equal(reader.state, 'connecting');
    assert.equal(reader.lastByteAt, 0);
    assert.ok(!reader.closed);
    ingest.closeAll('synthetic review finished');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    console.log('REPRODUCED: headers disable timeout; stall check skips connecting; close leaves readiness pending.');
})().catch(error => { ingest.closeAll('review failed'); console.error(error); process.exitCode = 1; });
