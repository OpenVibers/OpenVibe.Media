'use strict';
// Usage readings → Billing (plan T5 step 14, Media slice; server/billing.js, migrations/0004_billing_readings.sql).
// One closed UTC day aggregates into one gb-month reading per (project, subject, tier): that day's share of a
// GB-month (bytes / GB / days in the UTC month), every present location counted once (F3.4) and billed to the
// oldest object naming it. Only the newest closed day is aggregated — the query reads media_locations' current
// state, so a day missed during downtime is not billed. First-party and sandbox traffic is never recorded;
// re-running a period inserts nothing; a stored reading is never edited; and the relay's refused-vs-pending
// classification holds (only Billing refusing the reading itself is permanent). At MEDIA_BILLING_INTERVAL_MS=0
// nothing runs. Media emits gb-month only; gib-delivered is not emitted (route() calls are not bytes), so nothing
// here bills delivery.
const assert = require('assert');
const db = require('../server/db/database');
const { createMediaBilling, DAY_MS, GB, dayStart } = require('../server/billing');

const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0SEED';
const USR_OLD = 'usr_01JAB2C3D4E5F6G7H8J9K0OLD1';
const USR_NEW = 'usr_01JAB2C3D4E5F6G7H8J9K0NEW2';
const USR_A = 'usr_01JAB2C3D4E5F6G7H8J9K0AAA1';
const USR_B = 'usr_01JAB2C3D4E5F6G7H8J9K0BBB2';
const FIXED = Date.UTC(2026, 9, 4, 12, 0, 0);   // a fixed clock: nothing here depends on wall time
const settled = { intervalMs: 1000, url: '', audience: 'openvibe.billing', clientId: 'media', clientSecret: '', timeoutMs: 2000 };
const iso = (ms) => new Date(ms).toISOString();

(async () => {
    await db.initDb();
    const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const count = async (where = '1=1', params = []) => Number(await db.getDb().value(`SELECT COUNT(*) FROM billing_readings WHERE ${where}`, params));
    const rowOf = (key) => db.getDb().prepare('SELECT * FROM billing_readings WHERE event_id = ?').get(key);
    const periodStarts = async (metric) => (await db.getDb().prepare(`SELECT period_start FROM billing_periods WHERE metric = ? ORDER BY period_start`).all(metric)).map((r) => Number(r.period_start));
    // Only the locations need clearing between cases: the storage query joins locations to objects, so an object
    // with no location never bills (and objects are not deletable while a hold exists).
    const clearLocations = () => db.run('DELETE FROM media_locations');
    const addObject = (id, app, owner, size, created) => db.run(
        `INSERT INTO media_objects (id, app_id, namespace, kind, owner_subject, lifecycle_status, size_bytes, created_at)
         VALUES (?, ?, 'ns', 'file', ?, 'ready', ?, ?)`, [id, app, owner, size, created]);
    const addLocation = (objectId, provider, key, size) => db.run(
        `INSERT INTO media_locations (object_id, provider, key, state, size_bytes) VALUES (?, ?, ?, 'present', ?)`, [objectId, provider, key, size]);

    // Two tenant classes plus a first-party app: only the production project tenant is billable.
    await db.run(`INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES ('live', 'live', 'k', NULL, NULL)`);
    await db.run(`INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES ('app.prod', 'prod', 'k', ?, 'production')`, [PRJ]);
    await db.run(`INSERT INTO apps (app_id, name, api_key_hash, project_id, env) VALUES ('app.sbx', 'sandbox', 'k', ?, 'sandbox')`, [PRJ]);

    const billing = createMediaBilling({ db: db.getDb(), config: settled, clock: { now: () => FIXED } });

    // 1. One closed UTC day → one gb-month reading per billable (project, subject, tier); first-party/sandbox out.
    await addObject('obj-prod', 'app.prod', USR, 2 * GB, '2026-01-01 00:00:00');
    await addObject('obj-sbx', 'app.sbx', USR, 5 * GB, '2026-01-01 00:00:00');
    await addObject('obj-first', 'live', USR, 9 * GB, '2026-01-01 00:00:00');
    await addLocation('obj-prod', 'local', 'k1', 2 * GB);
    await addLocation('obj-prod', 'r2', 'k2', 2 * GB);
    await addLocation('obj-sbx', 'local', 'k3', 5 * GB);
    await addLocation('obj-first', 'local', 'k4', 9 * GB);

    const day = dayStart(FIXED) - 2 * DAY_MS;              // 2026-10-02
    const first = await billing.aggregateStorageDay(day, { now: FIXED });
    assert.strictEqual(first.readings, 2, 'local and r2, not sandbox or first-party');
    assert.strictEqual(first.created, 2);
    const localKey = `media:store:${PRJ}:${USR}:local:${iso(day)}`;
    const r2Key = `media:store:${PRJ}:${USR}:r2:${iso(day)}`;
    const local = json((await rowOf(localKey)).envelope);
    assert.strictEqual(local.service, 'media');
    assert.strictEqual(local.project, PRJ);
    assert.strictEqual(local.subject, USR);
    assert.strictEqual(local.resource, 'gb-month');
    assert.strictEqual(local.operation, 'store');
    assert.strictEqual(local.unit, 'GB');
    assert.strictEqual(local.provider, 'local');
    assert.strictEqual(local.quantity, (2 * GB) / GB / 31, '2026-10 has 31 days: the day is 1/31 of a GB-month');
    assert.strictEqual(local.at, iso(day));
    assert.strictEqual(json((await rowOf(r2Key)).envelope).provider, 'r2');

    // 2. Re-aggregating the day inserts nothing (the period is marked; the key is idempotent).
    const before = await count();
    const again = await billing.aggregateStorageDay(day, { now: FIXED });
    assert.strictEqual(again.created, 0);
    assert.strictEqual(again.skipped, true);
    assert.strictEqual(await count(), before, 'a re-run changes no row');

    // 3. A stored reading is never edited: only the delivery columns move.
    await assert.rejects(
        db.run(`UPDATE billing_readings SET envelope = '{}'::jsonb WHERE event_id = ?`, [localKey]),
        /never edited/, 'the trigger refuses editing the reading');
    await db.run(`UPDATE billing_readings SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ?`, [FIXED + 10, localKey]);

    // 4. A daily reading is that day's share of a GB-month: 1 GB reads 1/30 in a 30-day month, 1/31 in a 31-day one.
    await clearLocations();
    await addObject('obj-month', 'app.prod', USR, GB, '2026-01-01 00:00:00');
    await addLocation('obj-month', 'local', 'month-key', GB);
    const sep = Date.UTC(2026, 8, 10);                    // 2026-09-10, September (30 days)
    const oct = Date.UTC(2026, 9, 10);                    // 2026-10-10, October (31 days)
    await billing.aggregateStorageDay(sep, { now: Date.UTC(2026, 9, 15) });
    await billing.aggregateStorageDay(oct, { now: Date.UTC(2026, 9, 15) });
    assert.strictEqual(json((await rowOf(`media:store:${PRJ}:${USR}:local:${iso(sep)}`)).envelope).quantity, 1 / 30);
    assert.strictEqual(json((await rowOf(`media:store:${PRJ}:${USR}:local:${iso(oct)}`)).envelope).quantity, 1 / 31);

    // 5. A location more than one object names (F3.4) bills once, to the oldest object naming it (created_at, then id).
    await clearLocations();
    await addObject('obj-old', 'app.prod', USR_OLD, GB, '2026-01-01 00:00:00');   // older
    await addObject('obj-new', 'app.prod', USR_NEW, GB, '2026-02-01 00:00:00');   // newer, names the same location
    await addLocation('obj-old', 'local', 'shared', 3 * GB);
    await addLocation('obj-new', 'local', 'shared', 3 * GB);
    await addObject('obj-a1', 'app.prod', USR_A, GB, '2026-03-01 00:00:00');      // same created_at as obj-a2
    await addObject('obj-a2', 'app.prod', USR_B, GB, '2026-03-01 00:00:00');
    await addLocation('obj-a1', 'local', 'tie', 2 * GB);
    await addLocation('obj-a2', 'local', 'tie', 2 * GB);

    const sharedDay = Date.UTC(2026, 10, 15);             // 2026-11-15
    const dedup = await billing.aggregateStorageDay(sharedDay, { now: Date.UTC(2026, 11, 1) });
    assert.strictEqual(dedup.readings, 2, 'one reading per distinct owner: each shared location billed once');
    assert.strictEqual(json((await rowOf(`media:store:${PRJ}:${USR_OLD}:local:${iso(sharedDay)}`)).envelope).quantity, (3 * GB) / GB / 30,
        'the shared location bills once, to the older object naming it');
    assert.strictEqual(await rowOf(`media:store:${PRJ}:${USR_NEW}:local:${iso(sharedDay)}`), undefined, 'the newer naming object is not billed');
    assert.strictEqual(json((await rowOf(`media:store:${PRJ}:${USR_A}:local:${iso(sharedDay)}`)).envelope).quantity, (2 * GB) / GB / 30,
        'an equal created_at breaks to the lowest object id');
    assert.strictEqual(await rowOf(`media:store:${PRJ}:${USR_B}:local:${iso(sharedDay)}`), undefined, 'the higher object id is not billed on the tie');

    // 6. Only the newest closed day is aggregated: after a 3-day gap the two missed days are not billed.
    await clearLocations();
    await addObject('obj-gap', 'app.prod', USR, GB, '2026-01-01 00:00:00');
    await addLocation('obj-gap', 'local', 'gap-key', GB);
    const t0 = Date.UTC(2026, 11, 20, 12, 0, 0);          // 2026-12-20 12:00 → newest closed day 12-19
    const t3 = t0 + 3 * DAY_MS;                            // 2026-12-23 12:00 → newest closed day 12-22
    const gap1 = await billing.aggregateClosed({ now: t0 });
    const gap2 = await billing.aggregateClosed({ now: t3 });
    assert.strictEqual(gap1.created, 1);
    assert.strictEqual(gap2.created, 1, 'the gap run bills only the newest closed day');
    const dec = (await periodStarts('gb-month')).filter((ms) => ms >= Date.UTC(2026, 11, 19) && ms <= Date.UTC(2026, 11, 22));
    assert.deepStrictEqual(dec, [Date.UTC(2026, 11, 19), Date.UTC(2026, 11, 22)], 'the missed days 12-20 and 12-21 are not billed');
    assert.ok(await rowOf(`media:store:${PRJ}:${USR}:local:${iso(Date.UTC(2026, 11, 22))}`), 'the newest closed day has its reading');
    assert.strictEqual(await rowOf(`media:store:${PRJ}:${USR}:local:${iso(Date.UTC(2026, 11, 21))}`), undefined, 'a missed day has none');

    // 7. Refused vs pending: only Billing refusing the reading itself (any other 4xx) is permanent.
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
        db: db.getDb(), clock: { now: () => FIXED }, fetchImpl, networkUrl: 'http://billing.test',
        config: { ...settled, url: 'http://billing.test', clientSecret: 's' },
    });
    // Push the aggregation readings out of the relay's way: this part posts one reading at a time (sequentially).
    await db.run(`UPDATE billing_readings SET next_attempt_at = ? WHERE event_id NOT LIKE 'k-%'`, [FIXED + 10 * DAY_MS]);
    await Object.entries(statuses).reduce(async (previous, [k, status]) => {
        await previous;
        await talking.record(talking.reporter.sample({ idempotency_key: k, project: PRJ, subject: USR,
            resource: 'gb-month', provider: 'local', operation: 'store', quantity: 1, unit: 'GB', at: iso(day) }));
        await talking.send();   // a pending row's backoff keeps it out of the next pass
        const r = await rowOf(k);
        if (status && status >= 400 && status < 500 && ![401, 403, 404, 408, 425, 429].includes(status)) {
            assert.ok(r.rejected_at, `${status} refuses the reading permanently`);
            assert.ok(!r.sent_at, `${status} is never sent`);
        } else {
            assert.ok(!r.rejected_at, `${status || 'network'} stays pending`);
            assert.ok(!r.sent_at, `${status || 'network'} is not marked sent`);
            assert.ok(Number(r.next_attempt_at) > FIXED || status === 0, `${status || 'network'} backs off`);
        }
    }, Promise.resolve());
    assert.ok(calls.length >= 1, 'the relay posted to Billing');

    // 8. MEDIA_BILLING_INTERVAL_MS=0 runs nothing: no timer, no aggregation, no reading.
    const periods = Number(await db.getDb().value('SELECT COUNT(*) FROM billing_periods'));
    const rows = await count();
    const off = createMediaBilling({ db: db.getDb(), config: { ...settled, intervalMs: 0, url: 'http://billing.test' }, clock: { now: () => FIXED } });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.start(), false);
    assert.strictEqual(off.running, false);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(Number(await db.getDb().value('SELECT COUNT(*) FROM billing_periods')), periods, 'nothing aggregates at interval 0');
    assert.strictEqual(await count(), rows, 'nothing is queued at interval 0');
    await off.stop();

    await talking.stop();
    await billing.stop();
    console.log('✅ media billing: daily gb-month readings per project/subject/tier (a month sums to one GB-month), shared locations billed once to the oldest owner, newest closed day only, first-party and sandbox excluded, idempotent and immutable, refused-vs-pending relay, off at interval 0');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
