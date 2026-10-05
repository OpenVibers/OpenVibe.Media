'use strict';
// Usage readings → Billing (plan T5 step 14, Media slice; server/billing.js, migrations/0003_billing_readings.sql).
// One closed UTC hour aggregates into one gib-delivered reading per (project, subject) and one closed UTC day into
// one gb-month reading per (project, subject, tier). First-party and sandbox traffic is never recorded; re-running a
// period inserts nothing; a stored reading is never edited; and the relay's refused-vs-pending classification holds
// (only Billing refusing the reading itself is permanent). At MEDIA_BILLING_INTERVAL_MS=0 nothing runs.
const assert = require('assert');
const db = require('../server/db/database');
const demand = require('../server/placement/demand');
const { createMediaBilling, HOUR_MS, DAY_MS, GIB, GB, hourStart, dayStart } = require('../server/billing');

const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0SEED';
const FIXED = Date.UTC(2026, 9, 4, 12, 0, 0);   // a fixed clock: nothing here depends on wall time
const settled = { intervalMs: 1000, url: '', audience: 'openvibe.billing', clientId: 'media', clientSecret: '', timeoutMs: 2000 };
const count = async (where = '1=1', params = []) => Number(await db.getDb().value(`SELECT COUNT(*) FROM billing_readings WHERE ${where}`, params));
const rowOf = (key) => db.getDb().prepare('SELECT * FROM billing_readings WHERE event_id = ?').get(key);
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

(async () => {
    const raw = db.getDb();
    await db.initDb();

    // Two tenant classes plus a first-party app: only the production project tenant is billable.
    await db.run(`INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES ('live', 'live', 'k', NULL, NULL)`);
    await db.run(`INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES (?, 'prod', 'k', ?, 'production')`, [`app.prod`, PRJ]);
    await db.run(`INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES (?, 'sandbox', 'k', ?, 'sandbox')`, [`app.sbx`, PRJ]);
    await db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, lifecycle_status, size_bytes) VALUES
        ('obj-prod', 'app.prod', 'app.' || ?, 'file', ?, 'ready', ?)`, [PRJ, USR, 2 * GIB]);
    await db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, lifecycle_status, size_bytes) VALUES
        ('obj-sbx', 'app.sbx', 'app.' || ?, 'file', ?, 'ready', ?)`, [PRJ, USR, 5 * GIB]);
    await db.run(`INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, lifecycle_status, size_bytes) VALUES
        ('obj-first', 'live', 'live', 'file', ?, 'ready', ?)`, [USR, 9 * GIB]);

    const hour = hourStart(FIXED) - 2 * HOUR_MS;   // a closed hour
    const day = dayStart(FIXED) - 2 * DAY_MS;      // a closed day
    demand._reset();
    demand.record({ objectId: 'obj-prod', now: hour + 60_000 });
    demand.record({ objectId: 'obj-prod', now: hour + 120_000 });
    demand.record({ objectId: 'obj-sbx', now: hour + 60_000 });
    demand.record({ objectId: 'obj-first', now: hour + 60_000 });
    // Stored bytes: the production object has a local and an R2 copy; the sandbox and first-party ones must not bill.
    await db.run(`INSERT INTO media_locations (object_id, provider, key, state, size_bytes) VALUES
        ('obj-prod', 'local', 'k1', 'present', ?), ('obj-prod', 'r2', 'k2', 'present', ?),
        ('obj-sbx', 'local', 'k3', 'present', ?), ('obj-first', 'local', 'k4', 'present', ?)`,
        [2 * GIB, 2 * GIB, 5 * GIB, 9 * GIB]);

    (async () => {
        const billing = createMediaBilling({ db: raw, config: settled, clock: { now: () => FIXED } });

        // 1. One closed UTC hour → one gib-delivered reading per billable project/subject.
        const first = await billing.aggregateDeliveryHour(hour, { now: FIXED });
        assert.strictEqual(first.readings, 1, 'only the production project bills (first-party and sandbox do not)');
        assert.strictEqual(first.created, 1);
        const key = `media:deliver:${PRJ}:${USR}:${new Date(hour).toISOString()}`;
        const reading = json((await rowOf(key)).envelope);
        assert.strictEqual(reading.service, 'media');
        assert.strictEqual(reading.project, PRJ);
        assert.strictEqual(reading.subject, USR);
        assert.strictEqual(reading.resource, 'gib-delivered');
        assert.strictEqual(reading.operation, 'deliver');
        assert.strictEqual(reading.unit, 'GiB');
        assert.strictEqual(reading.quantity, 4, 'two reads x 2 GiB');
        assert.strictEqual(reading.at, new Date(hour).toISOString());

        // 2. Re-aggregating the hour inserts nothing (the period is marked; the key is idempotent).
        const before = await count();
        const again = await billing.aggregateDeliveryHour(hour, { now: FIXED });
        assert.strictEqual(again.created, 0);
        assert.strictEqual(again.skipped, true);
        assert.strictEqual(await count(), before, 'a re-run changes no row');

        // 3. One closed UTC day → one gb-month reading per billable (project, subject, tier).
        const sfirst = await billing.aggregateStorageDay(day, { now: FIXED });
        assert.strictEqual(sfirst.readings, 2, 'local and r2, not sandbox or first-party');
        const localKey = `media:store:${PRJ}:${USR}:local:${new Date(day).toISOString()}`;
        const r2Key = `media:store:${PRJ}:${USR}:r2:${new Date(day).toISOString()}`;
        const local = json((await rowOf(localKey)).envelope);
        assert.strictEqual(local.resource, 'gb-month');
        assert.strictEqual(local.unit, 'GB');
        assert.strictEqual(local.provider, 'local');
        assert.strictEqual(local.quantity, (2 * GIB) / GB);
        assert.strictEqual(json((await rowOf(r2Key)).envelope).provider, 'r2');
        const sAgain = await billing.aggregateStorageDay(day, { now: FIXED });
        assert.strictEqual(sAgain.created, 0);
        assert.strictEqual(sAgain.skipped, true);

        // 4. A stored reading is never edited: only the delivery columns move.
        await assert.rejects(
            db.run(`UPDATE billing_readings SET envelope = '{}'::jsonb WHERE event_id = ?`, [key]),
            /never edited/, 'the trigger refuses editing the reading');
        await db.run(`UPDATE billing_readings SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ?`, [FIXED + 10, key]);

        // 5. Refused vs pending: only Billing refusing the reading itself (any other 4xx) is permanent.
        const statuses = {
            'k-refuse-422': 422, 'k-refuse-400': 400, 'k-pending-503': 503, 'k-pending-500': 500,
            'k-pending-401': 401, 'k-pending-403': 403, 'k-pending-404': 404, 'k-pending-408': 408,
            'k-pending-425': 425, 'k-pending-429': 429, 'k-pending-net': 0,
        };
        const calls = [];
        const fetchImpl = async (url, opts) => {
            if (String(url).endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 300 }) };
            const sent = JSON.parse(opts.body);
            const status = statuses[sent.idempotency_key];
            calls.push(sent.idempotency_key);
            if (status === 0) throw new Error('connection refused');
            return { ok: status < 400, status, text: async () => `status ${status}`, json: async () => ({}) };
        };
        const talking = createMediaBilling({
            db: raw, clock: { now: () => FIXED }, fetchImpl, networkUrl: 'http://billing.test',
            config: { ...settled, url: 'http://billing.test', clientSecret: 's' },
        });
        // Push the aggregation readings out of the relay's way: this part posts one reading at a time.
        await db.run(`UPDATE billing_readings SET next_attempt_at = ? WHERE event_id NOT LIKE 'k-%'`, [FIXED + 10 * DAY_MS]);
        for (const [k, status] of Object.entries(statuses)) {
            await talking.record(talking.reporter.sample({ idempotency_key: k, project: PRJ, subject: USR,
                resource: 'gib-delivered', provider: 'local', operation: 'deliver', quantity: 1, unit: 'GiB', at: new Date(hour).toISOString() }));
            await talking.send();   // one due row at a time: a pending row's backoff keeps it out of the next pass
            const r = await rowOf(k);
            if (status && status >= 400 && status < 500 && ![401, 403, 404, 408, 425, 429].includes(status)) {
                assert.ok(r.rejected_at, `${status} refuses the reading for good`);
                assert.ok(!r.sent_at, `${status} is never sent`);
            } else {
                assert.ok(!r.rejected_at, `${status || 'network'} stays pending`);
                assert.ok(!r.sent_at, `${status || 'network'} is not marked sent`);
                assert.ok(Number(r.next_attempt_at) > FIXED || status === 0, `${status || 'network'} backs off`);
            }
        }
        assert.ok(calls.length >= 1, 'the relay posted to Billing');

        // 6. MEDIA_BILLING_INTERVAL_MS=0 runs nothing: no timer, no aggregation, no reading.
        const periods = Number(await raw.value('SELECT COUNT(*) FROM billing_periods'));
        const rows = await count();
        const off = createMediaBilling({ db: raw, config: { ...settled, intervalMs: 0, url: 'http://billing.test' }, clock: { now: () => FIXED } });
        assert.strictEqual(off.enabled, false);
        assert.strictEqual(off.start(), false);
        assert.strictEqual(off.running, false);
        await new Promise((r) => setTimeout(r, 80));
        assert.strictEqual(Number(await raw.value('SELECT COUNT(*) FROM billing_periods')), periods, 'nothing aggregates at interval 0');
        assert.strictEqual(await count(), rows, 'nothing is queued at interval 0');
        await off.stop();

        await talking.stop();
        await billing.stop();
        demand._reset();
        console.log('✅ media billing: hourly gib-delivered and daily gb-month readings per project/subject, first-party and sandbox excluded, idempotent and immutable, refused-vs-pending relay, off at interval 0');
        process.exit(0);
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
