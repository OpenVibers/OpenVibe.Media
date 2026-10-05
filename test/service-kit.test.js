'use strict';
/**
 * openvibe-sdk/service in Media (plan B4): the SIGTERM/SIGINT shutdown is the kit's gracefulStop, not
 * the hand-written shutdown()/process.on pair it replaces. It runs the stop steps (the recorder first —
 * stopAll() signalling FFmpeg before the worker and pollers stop — the tiering sweep, health job, verify
 * job, job worker, owner-subject job, JWKS refresher and events outbox stopped, the actor-limits Valkey
 * closed, the timers cleared), drains the server for 60 s so in-flight uploads and large downloads are
 * not cut at the kit's 4 s default, then closes the database; the whole stop is bounded at 70 s like the
 * systemd unit, and Media exits 0 past the deadline. A failing step is logged and the stop goes on.
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

// Slice a balanced (...) / [...] starting at `from` (source[from] is the opener), so the static checks
// read the whole gracefulStop call without depending on character offsets.
function balanced(source, from, open, close) {
    let depth = 0;
    for (let i = from; i < source.length; i++) {
        if (source[i] === open) depth++;
        else if (source[i] === close) { depth--; if (depth === 0) return source.slice(from, i + 1); }
    }
    throw new Error(`unbalanced ${open} at ${from}`);
}
function gracefulStopCall(source) {
    const at = source.indexOf('gracefulStop(');
    assert.ok(at > 0, 'server/index.js calls gracefulStop');
    return balanced(source, at + 'gracefulStop'.length, '(', ')');
}
function optionArray(call, name) {
    const m = call.match(new RegExp(`\\b${name}:\\s*\\[`));
    assert.ok(m, `the gracefulStop call has a ${name} array`);
    return balanced(call, m.index + m[0].length - 1, '[', ']');
}

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

t("the one stop names Media, stops the recorder first, keeps every handle, and uses the 60 s drain / 70 s deadline / exit 0", () => {
    const call = gracefulStopCall(source);
    assert.match(call, /name: 'Media'/);
    assert.match(call, /drainMs: 60000/, "a 60 s drain (VOD_STOP_GRACE_MS) so in-flight uploads/large downloads are not cut at the kit's 4 s default");
    assert.match(call, /deadlineMs: 70000/, 'the 70 s stop the systemd unit leaves room for (TimeoutStopSec=80)');
    assert.match(call, /deadlineExitCode: 0/, 'Media exits 0 past the deadline, like the 5 s family');
    assert.match(call, /close: \[\(\) => db\.close\(\)\]/);
    assert.doesNotMatch(call, /beforeDrain/, 'the recorder is a stop step now, not beforeDrain (the kit runs beforeDrain after stop)');

    // The recorder stops first, before every other handle — the order the hand-written shutdown ran.
    const stop = optionArray(call, 'stop');
    const recorderAt = stop.indexOf('recorder.stopAll()');
    assert.ok(recorderAt > 0, 'recorder.stopAll() is a stop step');
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
    ]) {
        const stepAt = stop.indexOf(step);
        assert.ok(stepAt > 0, `the stop still names ${step}`);
        assert.ok(recorderAt < stepAt, `recorder.stopAll() runs before ${step}`);
    }
    assert.doesNotMatch(source, /deadlineExitCode: 1/);
});

t('the stop runs the recorder first, drains the server, then closes, and exits 0 exactly once', async () => {
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
            drainMs: 60000,
            stop: [
                () => { order.push(server.listening ? 'recorder while listening' : 'recorder too late'); if (fails) throw new Error('recorder'); },
                () => { order.push('worker'); },
            ],
            close: [() => { order.push(server.listening ? 'close while listening' : 'close after drain'); }],
            deadlineMs: 70000, deadlineExitCode: 0,
            exit: (c) => { exited = c; exits++; },
            log: { log() {}, warn: (m) => warns.push(m), error() {} },
        });
        const [code, again] = await Promise.all([kit.stop('SIGTERM'), kit.stop('SIGINT')]);
        assert.deepStrictEqual(order, ['recorder while listening', 'worker', 'close after drain'], 'the recorder stops first while the server still listens; close runs after the drain');
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
