/**
 * Settings › System › Devices: pairing a TV app by its code, and the signed-in devices.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    // ---- Devices tab ---------------------------------------------------

    initDevices() {
        const btn = document.getElementById('pair-approve');
        if (!btn) return;
        btn.addEventListener('click', () => this.approveDevice());

        const input = document.getElementById('pair-code');
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.approveDevice();
        });
        // #19 (0365): once a whole code is typed, say which device is asking before it is approved.
        input?.addEventListener('input', () => this.lookUpPairing());
    },

    async lookUpPairing() {
        const input = document.getElementById('pair-code');
        const status = document.getElementById('pair-status');
        const code = (input?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!status) return;
        if (code.length < 6) { status.textContent = ''; return; }
        try {
            const p = await API.request('GET', `/devices/pair/pending?code=${encodeURIComponent(code)}`);
            if (((input?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')) !== code) return; // typed on since
            const mins = Math.max(0, Math.round((Date.now() - p.askedAt) / 60000));
            status.textContent = `Asking: ${p.name} · ${SettingsPage.deviceLine(p.app, p.platform)} · ${mins < 1 ? 'just now' : `${mins} min ago`}`;
        } catch (err) {
            status.textContent = UI.errorText(err, 'That code was not found.');
        }
    },

    async approveDevice() {
        const input = document.getElementById('pair-code');
        const status = document.getElementById('pair-status');
        const code = (input?.value || '').trim().toUpperCase();
        if (!code) return;

        try {
            const result = await API.request('POST', '/devices/pair/approve', { code });
            if (status) status.textContent = `Paired ${result.device.name}`;
            if (input) input.value = '';
            await this.loadDevices();
            setTimeout(() => { if (status) status.textContent = ''; }, 4000);
        } catch (err) {
            if (status) status.textContent = UI.errorText(err, 'That code was not accepted.');
        }
    },

    async loadDevices() {
        const list = document.getElementById('devices-list');
        if (!list) return;
        try {
            const devices = await API.request('GET', '/devices');
            const active = devices.filter(d => !d.revoked_at);
            if (active.length === 0) {
                UI.setState(list, 'empty', { title: 'No devices signed in yet', detail: 'Enter the code a TV app shows to pair it.' });
                return;
            }
            const e = (v) => UI.escape(v);
            list.innerHTML = active.map(d => {
                const seen = d.last_seen_at ? UI.dateTime(d.last_seen_at) : 'never';
                return `
                <div class="setting-item">
                    <div class="setting-info">
                        <span class="setting-label">${e(d.name || 'Unnamed device')}</span>
                        <span class="setting-hint">${e(SettingsPage.deviceLine(d.app, d.platform))} · last seen <span class="pig-amount">${e(seen)}</span></span>
                    </div>
                    <button class="btn btn-sm btn-danger" data-revoke="${e(d.id)}">Remove</button>
                </div>`;
            }).join('');

            list.querySelectorAll('[data-revoke]').forEach(b => {
                b.addEventListener('click', async () => {
                    if (!confirm('Sign this device out? It will need to sign in again.')) return;
                    b.disabled = true;
                    try {
                        await API.request('DELETE', `/devices/${b.dataset.revoke}`);
                        await this.loadDevices();
                    } catch (err) {
                        b.disabled = false;
                        UI.toast(UI.errorText(err, 'Could not sign the device out.'), { kind: 'error' });
                    }
                });
            });
        } catch (err) {
            console.error('Devices failed to load:', err);
            UI.setState(list, 'error', 'The signed-in devices could not be loaded.', { run: () => this.loadDevices() });
        }
    },
});

/**
 * #19 (0363): what a device is and runs, from the app's own X-PigTV-Client (GET /api/devices `app`):
 * "Apple TV · tvOS 26.1 · PigTV 84", or the platform alone before the app has said.
 */
SettingsPage.deviceLine = (app, platform) => {
    if (!app) return `${platform || 'unknown'} · app version not reported yet`;
    if (!app.build) return app.text;
    return [app.kind || app.model, app.os, `PigTV ${app.build}`].filter(Boolean).join(' · ');
};
