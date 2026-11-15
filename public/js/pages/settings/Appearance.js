/**
 * Settings › System › Appearance: the theme, kept per device.
 * One part of SettingsPage (pages/Settings.js), added to its prototype; index.html loads it after Settings.js (#64).
 */
Object.assign(SettingsPage.prototype, {
    // ---- UI tab --------------------------------------------------------

    initUiSettings() {
        // Theme applies immediately and is stored per device rather than on the
        // server: which appearance suits a phone at night is not the same
        // answer as a desktop in daylight.
        const themeSelect = document.getElementById('setting-theme');
        if (themeSelect) {
            themeSelect.addEventListener('change', () => window.Theme?.set(themeSelect.value));
        }
    },

    loadUiSettings() {
        const themeSelect = document.getElementById('setting-theme');
        if (themeSelect && window.Theme) themeSelect.value = window.Theme.choice;
    },
});
