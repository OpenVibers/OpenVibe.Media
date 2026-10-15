'use strict';
// Request telemetry (openvibe-sdk/service, plan T1 step 10): server/index.js mounts the process-wide middleware right after
// the metrics, calls telemetry.init() for service 'media' with a PostgreSQL sink and starts the 14-day retention, never
// under a restore drill, and flushes before the database closes. Through express, five hits on one route flush as ONE
// aggregated http.request sample; the migration's table takes the retention.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { telemetry } = require('openvibe-sdk/service');
const { pruneTelemetry } = require('openvibe-sdk/telemetry');

(async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.ok(src.indexOf('app.use(telemetry.middleware)') > src.indexOf('observability.instrument(app'), 'the middleware follows the metrics');
    assert.match(src, /if \(!drill\.enabled\) \{\n\s+telemetry\.init\(\{ service: 'media', sink: createPgTelemetrySink\(/, 'init, never under a drill');
    assert.match(src, /telemetryRetention = startTelemetryRetention\(\{ db: db\.getDb\(\), log: console, olderThanDays: 14 \}\)/);
    assert.match(src, /close: \[async \(\) => \{ if \(telemetryRetention\) await telemetryRetention\.stop\(\); await telemetry\.stop\(\); \}, \(\) => db\.close\(\)\]/, 'the flush runs before the database closes');

    const app = express();
    app.use(telemetry.middleware);
    app.get('/v/:id', (req, res) => res.send('watch'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const samples = [];
    telemetry.init({ service: 'media', sink: async (batch) => { samples.push(...batch); }, intervalMs: 3600e3 });
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await fetch(`${base}/v/${i}`)).status, 200);
        await telemetry.flush();
        const hit = samples.filter((s) => s.operation === 'http.request' && s.resource === '/v/:id' && s.status === '2xx');
        assert.strictEqual(hit.length, 1, JSON.stringify(samples));
        assert.strictEqual(hit[0].extra.count, 5, 'one sample per route template, never per URL');

        const db = require('../server/db/database').getDb();
        await db.query('DELETE FROM telemetry_samples');
        const insert = (days) => db.query("INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'media', 'http.request')", [days]);
        await insert(20);
        await insert(1);
        assert.strictEqual(await pruneTelemetry({ db, olderThanDays: 14 }), 1);
        assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM telemetry_samples')).rows[0].n, 1);
        console.log('telemetry ok');
    } finally {
        await telemetry.stop();
        await new Promise((r) => server.close(r));
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
