const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

// Copy the server so its relative data paths never touch real data, and
// recordings routes can use temporary test files.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pigtv-async-io-'));
fs.cpSync(path.join(__dirname, '../server'), path.join(sandbox, 'server'), { recursive: true });
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(sandbox, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');

process.env.JWT_SECRET = 'test-only-signing-key-not-used-outside-fixtures-12345';
const db = require(path.join(sandbox, 'server/db'));
const sqlite = require(path.join(sandbox, 'server/db/sqlite'));
const auth = require(path.join(sandbox, 'server/auth'));

let server, base, adminToken, recordingDir;

async function request(method, route, token, body) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${route}`, { method, headers,
        body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
}

before(async () => {
    recordingDir = path.join(sandbox, 'recordings');
    fs.mkdirSync(recordingDir, { recursive: true });

    // Create a test user and token
    const admin = await db.users.create({ username: 'owner', role: 'admin', passwordHash: await auth.hashPassword('owner-password') });
    adminToken = auth.generateToken(admin);

    const app = express();
    app.use(express.json());
    // Mount the recordings router
    app.use('/api/recordings', require(path.join(sandbox, 'server/routes/recordings')));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    sqlite.getDb().close();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a Range request returns 206 with correct Content-Range', async () => {
    // Create a test file with known content
    const testFile = path.join(recordingDir, 'test-range.mkv');
    const testContent = Buffer.alloc(10000);
    for (let i = 0; i < testContent.length; i++) {
        testContent[i] = i % 256;
    }
    fs.writeFileSync(testFile, testContent);

    // Add a recording to the database
    const { recordings: recordingsDb } = require(path.join(sandbox, 'server/db/recordingsDb'));
    const rec = recordingsDb.create({
        scheduled_id: 1,
        title: 'Test Range Recording',
        channel_name: 'Test Channel',
        channel_logo: null,
        source_id: 1,
        channel_item_id: 'test_1',
        file_path: testFile,
        started_at: Date.now()
    });
    recordingsDb.finish(rec.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 10000, duration_sec: 60 });

    // Test: request bytes 100-199 (100 bytes)
    const response = await fetch(`${base}/api/recordings/${rec.id}/stream`, {
        headers: { Range: 'bytes=100-199' }
    });

    assert.equal(response.status, 206, 'should return 206 Partial Content');
    assert.equal(response.headers.get('content-range'), 'bytes 100-199/10000', 'Content-Range header should be correct');
    assert.equal(response.headers.get('content-length'), '100', 'Content-Length should be 100');
    assert.equal(response.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges header should be present');

    const body = await response.arrayBuffer();
    assert.equal(body.byteLength, 100, 'response body should be exactly 100 bytes');
});

test('a missing recording file returns 404', async () => {
    // Add a recording that points to a non-existent file
    const { recordings: recordingsDb } = require(path.join(sandbox, 'server/db/recordingsDb'));
    const rec = recordingsDb.create({
        scheduled_id: 2,
        title: 'Missing Recording',
        channel_name: 'Test Channel',
        channel_logo: null,
        source_id: 1,
        channel_item_id: 'test_2',
        file_path: path.join(recordingDir, 'nonexistent.mkv'),
        started_at: Date.now()
    });
    recordingsDb.finish(rec.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 0, duration_sec: 0 });

    const response = await request('GET', `/api/recordings/${rec.id}/stream`, adminToken);
    assert.equal(response.status, 404, 'should return 404 for missing file');
    assert.deepEqual(response.data, { error: 'Recording file not found' });
});

test('a file deleted between lookup and stream read fails gracefully', async () => {
    // Create a test file
    const testFile = path.join(recordingDir, 'test-delete.mkv');
    fs.writeFileSync(testFile, Buffer.alloc(5000));

    // Add a recording to the database
    const { recordings: recordingsDb } = require(path.join(sandbox, 'server/db/recordingsDb'));
    const rec = recordingsDb.create({
        scheduled_id: 3,
        title: 'Delete Race Recording',
        channel_name: 'Test Channel',
        channel_logo: null,
        source_id: 1,
        channel_item_id: 'test_3',
        file_path: testFile,
        started_at: Date.now()
    });
    recordingsDb.finish(rec.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 5000, duration_sec: 30 });

    // Delete the file to simulate a race condition
    fs.unlinkSync(testFile);

    // Make the request - it should fail gracefully when pipeline tries to read
    // The pipeline will error when the file is no longer available
    try {
        const response = await fetch(`${base}/api/recordings/${rec.id}/stream`);
        // Either a 404 from access check (if it runs before the file handler closes)
        // or a connection error/broken response (if pipeline fails during streaming)
        assert.ok(!response.ok || response.status >= 400, 'request should fail gracefully');
    } catch (e) {
        // Network error or connection reset is acceptable - the file disappeared
        assert.ok(e.message.includes('fetch') || e.message.includes('connection'), 'error should be network-related');
    }
});

test('a missing recording returns 404 from /media.mp4', async () => {
    const response = await request('GET', '/api/recordings/99999/media.mp4', adminToken);
    assert.equal(response.status, 404, 'should return 404 for missing recording');
});

test('a missing file on /download returns 404', async () => {
    const { recordings: recordingsDb } = require(path.join(sandbox, 'server/db/recordingsDb'));
    const rec = recordingsDb.create({
        scheduled_id: 4,
        title: 'Missing Download',
        channel_name: 'Test Channel',
        channel_logo: null,
        source_id: 1,
        channel_item_id: 'test_4',
        file_path: path.join(recordingDir, 'no-file.mkv'),
        started_at: Date.now()
    });
    recordingsDb.finish(rec.id, { status: 'completed', ended_at: Date.now(), file_size_bytes: 0, duration_sec: 0 });

    const response = await request('GET', `/api/recordings/${rec.id}/download`, adminToken);
    assert.equal(response.status, 404, 'should return 404 for missing file');
});
