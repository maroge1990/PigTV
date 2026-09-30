const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 0176 (multi-provider P8): the admin licence banner's day rule and wording, and the
// Status page's Providers panel.
const js = (file) => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function reminders() {
    const context = vm.createContext({});
    vm.runInContext(js('providerReminders.js'), context);
    return context.ProviderReminders;
}

const store = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('a closed banner stays closed for the rest of the local day, and comes back the next', () => {
    const R = reminders();
    const s = store();
    // 07:30 local on 30 Sept: the UTC date may still be the 29th; the local day is what counts.
    const morning = new Date(2026, 8, 30, 7, 30);
    assert.equal(R.localDay(morning), '2026-09-30');
    assert.equal(R.dismissedToday(s, morning), false);
    R.dismiss(s, morning);
    assert.equal(R.dismissedToday(s, new Date(2026, 8, 30, 23, 59)), true, 'same local day');
    assert.equal(R.dismissedToday(s, new Date(2026, 9, 1, 0, 1)), false, 'next local day');
});

test('storage that throws never breaks the banner', () => {
    const R = reminders();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(R.dismissedToday(broken), false);
    assert.doesNotThrow(() => R.dismiss(broken));
});

test('wording: days left, tomorrow, and expired', () => {
    const R = reminders();
    const at = new Date(2027, 2, 30, 9).getTime();
    const [soon, tomorrow, gone] = R.lines([
        { id: 1, name: 'Trex', expiresAt: at, daysLeft: 5 },
        { id: 2, name: 'Dream4K', expiresAt: at, daysLeft: 1 },
        { id: 3, name: 'Strong8K', expiresAt: at, daysLeft: -2 }
    ]);
    assert.match(soon, /^Trex expires .+ \(in 5 days\)\. Renew it, then update the dates in Settings → Providers\.$/);
    assert.match(tomorrow, /\(tomorrow\)/);
    assert.match(gone, /^Strong8K expired on /);
    assert.deepEqual([...R.lines([])], []);
});

test('the Status page shows a Providers panel with state, connections, expiry and account', async () => {
    const elements = { 'status-content': { innerHTML: '', querySelector: () => null }, 'status-updated': { textContent: '' } };
    const status = {
        generatedAt: Date.now(), build: { display: 'build 0176' }, sessions: [], recordings: { active: [], upcoming: [] },
        events: [], recentProblems: [], sync: [], disk: { transcodeCache: { available: false }, recordings: { available: false } },
        providers: [
            { id: 1, name: 'Strong8K', role: 'primary', state: 'down', downUntil: Date.now() + 180000, connections: { used: 0, limit: 1 },
              expiresAt: Date.now() + 100 * 86400000, expired: false, accountOk: false },
            { id: 2, name: 'Trex <b>', role: 'backup', state: 'up', connections: { used: 1, limit: 1 },
              expiresAt: null, expired: false, accountOk: null }
        ]
    };
    const context = vm.createContext({
        console, localStorage: { getItem: () => 'tok' },
        document: { getElementById: (id) => elements[id] || null },
        setInterval: () => 1, clearInterval: () => {},
        fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => status })
    });
    context.window = context;
    vm.runInContext(js('api.js'), context);
    vm.runInContext(js('pages/StatusPage.js'), context);
    const page = new context.StatusPage({});
    page.show();
    await new Promise(r => setImmediate(r));
    page.hide();
    const html = elements['status-content'].innerHTML;
    assert.ok(html.includes('Providers'));
    assert.ok(html.includes('Strong8K') && html.includes('down until'), 'a down provider says until when');
    assert.ok(html.includes('Trex &lt;b&gt;'), 'names are escaped');
    assert.ok(html.includes('1/1') && html.includes('0/1'), 'connections used/limit');
    assert.ok(html.includes('not checked yet'), 'an account never read is not shown as an error');
});

test('the banner script loads before app.js and the old duplicate reminders route is gone', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.ok(html.indexOf('/js/providerReminders.js') > -1 && html.indexOf('/js/providerReminders.js') < html.indexOf('/js/app.js'));
    assert.equal(fs.existsSync(path.join(__dirname, '../server/routes/providerReminders.js')), false);
    assert.match(js('app.js'), /this\.showProviderReminders\(\)/);
    assert.match(js('app.js'), /closeBtn\.onclick = /);
});
