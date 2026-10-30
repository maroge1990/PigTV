const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #65 (0360): settings that misled or set traps. The page's own text, read from the files the browser loads.
const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');

test('the encode-only options say they apply only when PigTV re-encodes, and upscaling says it re-encodes every web play', () => {
    const html = read('index.html');
    assert.match(html, /<h3>Only when re-encoding<\/h3>/);
    assert.match(html, /On the web\s+player this <strong>re-encodes every play<\/strong>/);
    assert.doesNotMatch(html, /<h3>Encoder Settings<\/h3>/);
});

test('cross-references name where things are now', () => {
    assert.match(read('js/pages/StatusPage.js'), /Settings → Playback\. A change applies/);
    assert.doesNotMatch(read('js/pages/StatusPage.js'), /Settings, Transcoding/);
    assert.match(read('js/pages/BackupLinksSettings.js'), /the first card is the primary, every card below it is a backup/);
    assert.doesNotMatch(read('js/pages/BackupLinksSettings.js'), /set its role to Backup/);
});

test('deleting a provider says it removes favourites, numbers and scheduled recordings too', () => {
    assert.match(read('js/pages/ProvidersSettings.js'), /with the favourites, channel numbers and scheduled recordings on its channels/);
});

test('a renewal switch that cannot run is unticked and saved off, as the standby is', () => {
    const js = read('js/pages/Settings.js');
    assert.match(js, /if \(renewal\.disabled && renewal\.checked\) \{\s*renewal\.checked = false;\s*try \{ await API\.settings\.update\(\{ ingestReconnectRenewal: false \}\)/);
});
