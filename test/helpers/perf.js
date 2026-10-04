// Speed budgets (how fast, not whether it works). CI's main gate sets PIGTV_SKIP_PERF=1 so a
// slow shared runner never blocks an image; a separate, non-blocking job runs them and reports.
// Locally they run as part of `npm test`.
module.exports = process.env.PIGTV_SKIP_PERF === '1'
    ? { skip: 'a speed budget: run by the CI perf job, not the gate (PIGTV_SKIP_PERF=1)' }
    : {};
