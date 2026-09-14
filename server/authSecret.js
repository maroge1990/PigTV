const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Keep one signing key across container rebuilds using the existing data mount.
// Never fall back to a public key: route authorization depends on this key.
function loadSecret() {
    const configured = process.env.JWT_SECRET;
    if (configured !== undefined) {
        if (configured.length < 32 || configured === 'pigtv-secret-key-change-in-production') {
            throw new Error('JWT_SECRET must be a private random value of at least 32 characters; omit it to use a persisted installation key.');
        }
        return configured;
    }

    const directory = path.join(__dirname, '..', 'data');
    const filename = path.join(directory, 'auth-secret');
    fs.mkdirSync(directory, { recursive: true });
    try {
        fs.writeFileSync(filename, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
    const secret = fs.readFileSync(filename, 'utf8').trim();
    if (!/^[a-f0-9]{96}$/.test(secret)) {
        throw new Error('The persisted data/auth-secret is invalid. Restore it from backup; refusing to replace the installation key.');
    }
    return secret;
}

module.exports = loadSecret();
