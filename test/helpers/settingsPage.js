const fs = require('node:fs');
const path = require('node:path');

// #64: the Settings page is pages/Settings.js (tabs, address, which panel loads what) plus one file per section in
// pages/settings/, each adding its methods to SettingsPage.prototype. The files and their order are index.html's, so a
// test loads exactly what the browser does.
const PUBLIC = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const FILES = [...html.matchAll(/<script src="\/js\/(pages\/(?:Settings|settings\/[A-Za-z]+)\.js)(?:\?v=\d+)?"><\/script>/g)].map(m => m[1]);
if (FILES[0] !== 'pages/Settings.js' || FILES.length < 2) throw new Error(`index.html does not load Settings.js before its sections: ${FILES}`);

/** Every Settings file's source, in load order, as one script (for vm.runInContext, or to match against). */
function settingsSource() {
    return FILES.map(f => fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8')).join('\n');
}

module.exports = { SETTINGS_FILES: FILES, settingsSource };
