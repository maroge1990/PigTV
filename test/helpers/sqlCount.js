'use strict';
// Counts the SQL a better-sqlite3 handle runs, so a test can say "a repeat read
// executes 0 statements and opens 0 transactions".
//
//   const c = sqlCount(db);        // install BEFORE the code under test first prepares
//   ...; c.runs(/INSERT/)          // executions of .run on matching statements
//   c.gets(), c.alls(), c.executions(re)  // .get / .all / all three
//   c.prepares(re), c.transactions()      // prepare() calls, handle.transaction() calls
//   c.reset(); c.restore();
//
// It patches the handle instance's `prepare` and `transaction`, so statements
// prepared BEFORE the wrap (module-level cached ones) are not counted. Install
// it before the first call, or make the code re-prepare (a fresh handle, or a
// module's own reset hook). Filters are RegExps tested against the SQL text.
function sqlCount(db) {
    const origPrepare = db.prepare;
    const origTransaction = db.transaction;
    let log = [];
    let tx = 0;
    db.prepare = function (sql) {
        const stmt = origPrepare.call(this, sql);
        log.push({ kind: 'prepare', sql });
        for (const kind of ['run', 'get', 'all']) {
            const fn = stmt[kind];
            stmt[kind] = function (...a) { log.push({ kind, sql }); return fn.apply(this, a); };
        }
        return stmt;
    };
    db.transaction = function (...a) {
        const wrapped = origTransaction.apply(this, a);
        return function (...b) { tx++; return wrapped.apply(this, b); };
    };
    const count = (kinds, re) => log.filter(e => kinds.includes(e.kind) && (!re || re.test(e.sql))).length;
    return {
        prepares: re => count(['prepare'], re),
        runs: re => count(['run'], re),
        gets: re => count(['get'], re),
        alls: re => count(['all'], re),
        executions: re => count(['run', 'get', 'all'], re),
        transactions: () => tx,
        reset() { log = []; tx = 0; },
        restore() { db.prepare = origPrepare; db.transaction = origTransaction; },
    };
}
module.exports = { sqlCount };
