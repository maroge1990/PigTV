/**
 * Settings › Playback › Transcoding: the stream recovery and hardware decoding switches, and the detected hardware.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    initHwDecodeSettings() {
        // #64: each switch saves when changed (saveOnChange): a failed save puts it back and says why.
        const bind = (id, key, after = null) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', () => this.saveOnChange({
                key, value: el.checked, saved: !el.checked,
                save: (v) => API.settings.update({ [key]: v }).then(() => v),
                show: (v) => { el.checked = v; if (after) after(); }
            }));
        };
        bind('setting-vaapi-hw-decode', 'vaapiHwDecode');
        bind('setting-vaapi-cpu-scale', 'vaapiCpuScale');
        // R12: the standby only works while recovery is on, so its switch is greyed out otherwise.
        const relay = document.getElementById('setting-relay-enabled');
        const standby = document.getElementById('setting-standby-enabled');
        const renewal = document.getElementById('setting-ingest-renewal');
        const shared = document.getElementById('setting-shared-ingest');
        // A switch that cannot run is turned off and saved off (below); if that save fails it stays off here, as the
        // server treats it while the switch it needs is off, and the notice says to check it.
        const saveOff = (key) => this.saveOnChange({ key, value: false, saved: true, save: (v) => API.settings.update({ [key]: v }).then(() => v), tail: 'Check it before you rely on it.' });
        // #65 (0360): like the standby (0203), a renewal switch that cannot run is unticked and saved off, not left
        // ticked and greyed, which read as "still on".
        const syncRenewalAvailability = async () => {
            if (!renewal) return;
            renewal.disabled = !relay?.checked || !shared?.checked;
            if (renewal.disabled && renewal.checked) {
                renewal.checked = false;
                await saveOff('ingestReconnectRenewal');
            }
        };
        const syncStandbyAvailability = async () => {
            if (!standby || !relay) return;
            standby.disabled = !relay.checked;
            if (!relay.checked && standby.checked) {
                standby.checked = false;
                await saveOff('standbyEnabled');
            }
        };
        // A recovery or shared-ingest switch put back after a failed save greys out (or frees) what depends on it again.
        const resync = () => { syncRenewalAvailability(); syncStandbyAvailability(); };
        shared?.addEventListener('change', syncRenewalAvailability);
        bind('setting-relay-enabled', 'relayEnabled', resync);
        bind('setting-ingest-renewal', 'ingestReconnectRenewal');
        bind('setting-standby-enabled', 'standbyEnabled');
        bind('setting-warm-next-channel', 'warmNextChannel'); // R11
        bind('setting-shared-ingest', 'sharedIngestEnabled', resync); // Wave 5
        // 0203: turning recovery off also turns the standby off (it cannot run without it), and
        // says so: a ticked-but-greyed switch read as "still on".
        relay?.addEventListener('change', resync);
    },

    applyHwDecodeSettings(s) {
        const hw = document.getElementById('setting-vaapi-hw-decode');
        if (hw) {
            hw.checked = s.vaapiHwDecode !== false;
            const cpu = document.getElementById('setting-vaapi-cpu-scale');
            if (cpu) cpu.checked = s.vaapiCpuScale !== false;
            const relay = document.getElementById('setting-relay-enabled');
            const standby = document.getElementById('setting-standby-enabled');
            if (relay) relay.checked = s.relayEnabled === true;
            const renewal = document.getElementById('setting-ingest-renewal');
            if (renewal) { renewal.checked = s.ingestReconnectRenewal === true; renewal.disabled = s.relayEnabled !== true || s.sharedIngestEnabled !== true; }
            if (standby) {
                // Never shown ticked while recovery is off: the server treats it as off then.
                standby.checked = s.standbyEnabled === true && s.relayEnabled === true;
                standby.disabled = s.relayEnabled !== true;
            }
            const warm = document.getElementById('setting-warm-next-channel');
            if (warm) warm.checked = s.warmNextChannel === true;
            const shared = document.getElementById('setting-shared-ingest');
            if (shared) shared.checked = s.sharedIngestEnabled === true;
        }
    },

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo({ redetect = false } = {}) {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            // #61 (0367): "Re-detect GPU" probes again (a device passed through after the container started).
            const hwInfo = await API.request(redetect ? 'POST' : 'GET', redetect ? '/settings/hw-info/refresh' : '/settings/hw-info');
            const e = (v) => UI.escape(v);

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">NVIDIA</span>
                    <span class="hw-name">${e(hwInfo.nvidia.name)}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">AMD</span>
                    <span class="hw-name">${e(hwInfo.amf.name || 'Available')}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">Intel QSV</span>
                    <span class="hw-name">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">VAAPI</span>
                    <span class="hw-name">${e(hwInfo.vaapi.device || 'Available')}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${e(hwInfo.recommended)}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            html += `<p style="margin-top: var(--space-sm);"><button type="button" class="btn btn-sm btn-secondary" data-hw-redetect>Re-detect GPU</button>`
                + `${redetect ? ' <span class="setting-hint">Detected again just now.</span>' : ''}</p>`;
            container.innerHTML = html;
            this.wireHwRedetect(container);
        } catch (err) {
            console.error('Error loading hardware info:', err);
            UI.setState(container, 'error', 'The hardware information could not be loaded.', { run: () => this.loadHardwareInfo({ redetect }) });
        }
    },

    wireHwRedetect(container) {
        const button = container.querySelector?.('[data-hw-redetect]');
        button?.addEventListener('click', () => {
            button.disabled = true;
            button.textContent = 'Detecting…';
            this.loadHardwareInfo({ redetect: true });
        });
    },
});
