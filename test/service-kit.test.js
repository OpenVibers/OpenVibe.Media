'use strict';
/**
 * openvibe-sdk/service in Media (plan B4): the SIGTERM/SIGINT shutdown is the kit's gracefulStop, not
 * the hand-written shutdown()/process.on pair it replaces. It drains the server for the default 4 s,
 * then runs the stop steps (the recorder drained first in beforeDrain, the tiering sweep, health job,
 * verify job, job worker, owner-subject job, JWKS refresher and events outbox stopped, the actor-limits
 * Valkey closed, the timers cleared), then closes the database; the whole stop is bounded at 70 s like
 * the systemd unit, and Media exits 0 past the deadline. A failing step is logged and the stop goes on.
 * The static half reads server/index.js; the behavioural half drives gracefulStop with the same option
 * shape Media passes, with exports stubbed (/mirrors OpenVibe.Sources/test/service-kit.test.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { gracefulStop } = require('openvibe-sdk/service');

const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

// A tiny local runner, as in OpenVibe.Sources/test/service-kit.test.js: `node test/service-kit.test.js`
// prints one line per case and exits 1 on the first failure.
function suite(name) {
    const tests = [];
    const t = (n, fn) => tests.push([n, fn]);
    t.run = async () => {
        let failed = 0;
        for (const [n, fn] of tests) {
            try { await fn(); console.log(`  ok   ${n}`); } catch (err) { failed++; console.log(`  FAIL ${n}\n${err.stack}`); }
        }
        console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
        if (failed) process.exit(1);
    };
    return t;
}
const t = suite('service-kit');

t('server/index.js imports gracefulStop from openvibe-sdk/service and owns no signal handler', () => {
    assert.match(source, /const \{ gracefulStop \} = require\('openvibe-sdk\/service'\)/);
    assert.doesNotMatch(source, /process\.on\('SIGTERM'/);
    assert.doesNotMatch(source, /process\.on\('SIGINT'/);
    assert.doesNotMatch(source, /function shutdown\(/, 'the hand-written shutdown() is gone');
    assert.doesNotMatch(source, /shuttingDown/, 'the guard that made a second signal a no-op is the kit\'s now');
});

t("the one stop names Media, drains the recorder first, keeps every handle, and uses the 70 s deadline / exit 0", () => {
    const at = source.indexOf('gracefulStop(');
    assert.ok(at > 0, 'server/index.js calls gracefulStop');
    const call = source.slice(at, at + 1600);
    assert.match(call, /name: 'Media'/);
    assert.match(call, /deadlineMs: 70000/, 'the 70 s stop the systemd unit leaves room for (TimeoutStopSec=80)');
    assert.match(call, /deadlineExitCode: 0/, 'Media exits 0 past the deadline, like the 5 s family');
    assert.match(call, /beforeDrain: \(\) => recorder\.stopAll\(\)/, 'recordings drain while the server still takes connections');
    assert.match(call, /close: \[\(\) => db\.close\(\)\]/);
    // Every handle the hand-written shutdown carried is a stop step now.
    for (const step of [
        'vodStorage.stop()',
        'healthJob.stop()',
        "require('./objects/verify-job').stop()",
        "require('./jobs/worker').stop()",
        "require('./objects/owner-subject-job').stop()",
        'auth.stopJwksRefresh()',
        "require('./events')._reset()",
        "require('./actor-limits').valkey()",
        'clearInterval(t)',
    ]) assert.ok(call.includes(step), `the stop still names ${step}`);
    assert.doesNotMatch(source, /deadlineExitCode: 1/);
});

t('the stop runs stop → beforeDrain → close, drains the server, and exits 0 exactly once', async () => {
    // Media passes no handles, so a step that throws is logged and the stop goes on (the try/catch the
    // old shutdown carried); the exit code stays the deadline's 0 either way.
    for (const fails of [false, true]) {
        const server = http.createServer((_req, res) => res.end('ok'));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const order = [];
        const warns = [];
        let exits = 0;
        let exited = null;
        const kit = gracefulStop({
            name: 'Media', server, signals: false,
            stop: [() => { order.push('stop'); if (fails) throw new Error('worker'); }],
            beforeDrain: () => { order.push(server.listening ? 'beforeDrain while listening' : 'beforeDrain too late'); },
            close: [() => { order.push(server.listening ? 'close while listening' : 'close after drain'); }],
            deadlineMs: 70000, deadlineExitCode: 0,
            exit: (c) => { exited = c; exits++; },
            log: { log() {}, warn: (m) => warns.push(m), error() {} },
        });
        const [code, again] = await Promise.all([kit.stop('SIGTERM'), kit.stop('SIGINT')]);
        assert.deepStrictEqual(order, ['stop', 'beforeDrain while listening', 'close after drain'], 'beforeDrain is the last moment the server listens; close runs after the drain');
        assert.strictEqual(code, 0, 'Media exits 0 past the deadline and on a logged step failure');
        assert.strictEqual(again, code, 'a second signal changes nothing');
        assert.strictEqual(exited, 0);
        assert.strictEqual(exits, 1, 'exit is called once');
        assert.strictEqual(kit.stopping(), true);
        assert.strictEqual(server.listening, false);
        if (fails) assert.ok(warns.some((w) => /stop step failed/.test(w)), 'the failing step is logged');
    }
});

t.run();
