/** Shared cooldown for ESPN's public host. Legacy fixtures opt in only while the dashboard is enabled. */
let until = 0, failures = 0;
function blocked(now = Date.now()) { return now < until; }
function observe(status, retryAfter, now = Date.now()) {
    if (status === 429 || status >= 500) {
        failures = Math.min(failures + 1, 5);
        const seconds = Number(retryAfter);
        const requested = retryAfter && Number.isFinite(seconds) ? seconds * 1000
            : retryAfter ? Math.max(0, Date.parse(retryAfter) - now) : 0;
        const cooldown = Math.min(15 * 60000, Math.max(60000 * 2 ** (failures - 1), Number.isFinite(requested) ? requested : 0));
        until = Math.max(until, now + cooldown);
    } else if (status >= 200 && status < 300 && !blocked(now)) {
        failures = 0;
    }
}
function retryAt(now = Date.now()) { return blocked(now) ? until : null; }
function reset() { until = 0; failures = 0; }
module.exports = { blocked, observe, retryAt, reset };
