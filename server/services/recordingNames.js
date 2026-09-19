/**
 * Timestamp used in recording file names, in the server's local time.
 *
 * "Local" means whatever TZ the process runs under. The Docker image sets none,
 * so out of the box that is UTC and a 7:30pm programme is filed as 09-30 (in
 * Sydney, say) - which is why docker-compose.yml passes TZ through. Node reads
 * TZ from its own ICU data, so no tzdata package is needed for this.
 *
 * Kept in its own module, with no dependencies, so it can be exercised under
 * different TZ values in a child process.
 */
function formatLocalStamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

module.exports = { formatLocalStamp };
