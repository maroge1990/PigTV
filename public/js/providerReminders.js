/**
 * Licence reminders for the admin banner (0176, multi-provider P8; contract C-K).
 * Pure helpers, so the day rule and the wording can be tested without the app shell.
 */
(function (root) {
    // The viewer's own calendar day, not UTC's: in Melbourne the UTC date is
    // "yesterday" until 10 am, which would bring a closed banner back each morning.
    function localDay(date = new Date()) {
        const pad = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function formatDate(ms) {
        return new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }

    function lines(reminders) {
        return (reminders || []).map(r => {
            if (!(r.daysLeft > 0)) return `${r.name} expired on ${formatDate(r.expiresAt)}. Renew it, then update the dates in Settings → Providers.`;
            const when = r.daysLeft === 1 ? 'tomorrow' : `in ${r.daysLeft} days`;
            return `${r.name} expires ${formatDate(r.expiresAt)} (${when}). Renew it, then update the dates in Settings → Providers.`;
        });
    }

    function dismissedToday(storage, now = new Date()) {
        try { return storage.getItem('pigtv_reminder_dismissed') === localDay(now); } catch { return false; }
    }

    function dismiss(storage, now = new Date()) {
        try { storage.setItem('pigtv_reminder_dismissed', localDay(now)); } catch { /* private mode: hidden until reload */ }
    }

    root.ProviderReminders = { localDay, lines, dismissedToday, dismiss };
})(typeof window !== 'undefined' ? window : globalThis);
