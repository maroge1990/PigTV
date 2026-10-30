/**
 * R11 (Plan B1): one webhook for the things worth a phone notification without opening the
 * Status page: a provider going down, a recording failing, a provider licence about to end.
 *
 * Settings (System): `notifyWebhookUrl` (http/https; empty = off) and `notifyWebhookFormat`:
 *   'json'  POST {event, title, message, at, server} (Home Assistant, most automation tools)
 *   'text'  POST the message as text/plain with a `Title` header (ntfy)
 *
 * Fire and forget: a send never blocks or fails what caused it, times out after 10 s, and the
 * same event key is sent at most once per DEDUPE_MS. Messages carry names and fixed sentences
 * only, never a provider URL or login (redact() on anything that came from elsewhere), and the
 * webhook URL itself is never logged (it is often a secret: an ntfy topic, a Home Assistant id).
 */
const { redact } = require('../redact');

const DEDUPE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10000;
const EVENTS = ['provider-down', 'recording-failed', 'licence-expiring', 'guide-stale', 'test']; // #11: guide-stale
const lastSent = new Map(); // key -> ms

/** '' or a usable http(s) URL, else null (invalid). */
function cleanUrl(value) {
    if (value === undefined || value === null) return '';
    const s = String(value).trim();
    if (!s) return '';
    if (s.length > 500 || /\s/.test(s)) return null;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
    } catch { return null; }
}

async function currentSettings() {
    try { return await require('../db').settings.get(); } catch { return {}; }
}

/**
 * Send `event` unless it was sent under the same `key` within DEDUPE_MS (`force` skips that,
 * for the Settings test). Resolves { sent, status?, error?, skipped? }; never rejects.
 */
async function send(event, { title, message, key = event, force = false, now = Date.now(), fetchImpl = fetch } = {}) {
    if (!EVENTS.includes(event)) return { sent: false, skipped: 'unknown event' };
    const settings = await currentSettings();
    const url = cleanUrl(settings.notifyWebhookUrl);
    if (!url) return { sent: false, skipped: 'no webhook' };
    if (!force && lastSent.has(key) && now - lastSent.get(key) < DEDUPE_MS) return { sent: false, skipped: 'duplicate' };
    lastSent.set(key, now);
    const safeTitle = redact(String(title || 'PigTV'));
    const safeMessage = redact(String(message || ''));
    const text = settings.notifyWebhookFormat === 'text';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            signal: controller.signal,
            headers: text
                ? { 'Content-Type': 'text/plain; charset=utf-8', Title: safeTitle.replace(/[^\x20-\x7e]/g, '') || 'PigTV', Tags: event }
                : { 'Content-Type': 'application/json' },
            body: text ? safeMessage : JSON.stringify({ event, title: safeTitle, message: safeMessage, at: now, server: 'PigTV' })
        });
        if (!res.ok) {
            console.warn(`[Notify] ${event}: the webhook answered HTTP ${res.status}`);
            return { sent: false, status: res.status };
        }
        return { sent: true, status: res.status };
    } catch (err) {
        console.warn(`[Notify] ${event}: the webhook could not be reached (${err.name === 'AbortError' ? 'timed out' : 'network error'})`);
        return { sent: false, error: err.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
}

/** Fire and forget (the callers are hot paths that must not wait). */
function emit(event, details) {
    send(event, details).catch(() => {});
}

function providerDown(name, why) {
    emit('provider-down', {
        title: `PigTV: ${name} is down`,
        message: `${name} is down (${why}). Plays and recordings use a backup provider where one carries the channel.`,
        key: `provider-down:${name}`
    });
}

function recordingFailed(schedule, error) {
    const title = schedule?.title || 'A recording';
    const channel = schedule?.channel_name ? ` on ${schedule.channel_name}` : '';
    emit('recording-failed', {
        title: 'PigTV: recording failed',
        message: `"${title}"${channel} failed${error ? `: ${error}` : '.'}`,
        key: `recording-failed:${schedule?.id ?? title}`
    });
}

/** `reminders` from providerAccounts.reminders(): one message per provider per day count. */
function licencesExpiring(reminders) {
    for (const r of reminders || []) {
        const when = r.daysLeft <= 0 ? 'has expired' : r.daysLeft === 1 ? 'expires tomorrow' : `expires in ${r.daysLeft} days`;
        emit('licence-expiring', {
            title: `PigTV: ${r.name} ${when}`,
            message: `The ${r.name} subscription ${when}. Renew it with the provider.`,
            key: `licence:${r.id}:${r.daysLeft}`
        });
    }
}

function _reset() { lastSent.clear(); }

module.exports = { send, emit, cleanUrl, providerDown, recordingFailed, licencesExpiring, EVENTS, DEDUPE_MS, _reset };
