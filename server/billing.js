'use strict';
/**
 * Media's storage and delivery usage readings → OpenVibe.Billing (plan T5 step 14, Media slice).
 *
 * Media is the authority for every stored byte and every delivered byte, so it emits two platform.usage-sample@1
 * metrics, the two the platform.rate-card@1 contract names for it:
 *
 *   gib-delivered  the bytes served in one closed UTC hour, per (project, subject): the hour's object reads (the
 *                  placement demand rollups, server/placement/demand.js) × the object's size_bytes, in GiB.
 *                  resource 'gib-delivered', provider 'local', unit 'GiB', operation 'deliver'.
 *   gb-month       the bytes stored for one closed UTC day, per (project, subject, tier): every present copy in
 *                  media_locations, once a day ("daily partition"), in GB. resource 'gb-month', provider the tier
 *                  (local/b2/r2), unit 'GB', operation 'store'.
 *
 * First-party traffic (a tenant with no project) and sandbox tenants are never recorded: the reporter bills whatever
 * reading it is given, so the aggregate query joins apps and keeps only `env = 'production'` rows with a project id.
 * A reading without the object's owner_subject is still stored (Billing leaves it unrated: rating needs a user
 * subject).
 *
 * The reporter is the SDK's own (openvibe-sdk/usage createUsageReporter): it derives the sample, queues it
 * idempotency-keyed in the outbox inside the aggregation's transaction, and relays it to Billing's
 * billing.usage.record (POST /api/v1/usage) with Media's Network service token (createServiceTokenClient, clientId
 * 'media', audience openvibe.billing; Network grants exactly billing.usage.record). A relay that cannot reach
 * Billing (no grant yet, a missing route, a timeout, backpressure, a 401/403/404/408/425/429 or a 5xx) stays
 * pending with backoff; only Billing refusing the reading itself (any other 4xx) is marked rejected and never
 * retried, so nothing is billed twice. A reading is never edited (migrations/0004_billing_readings.sql).
 *
 * Off by default: MEDIA_BILLING_INTERVAL_MS=0 starts no timer and aggregates nothing; a restore drill starts
 * nothing at all. With an interval but no OV_BILLING_URL (or OV_OAUTH_CLIENT_SECRET) readings are aggregated and
 * stay queued.
 *
 *   const billing = createMediaBilling({ db, config: config.billing, networkUrl: config.network.internalUrl });
 *   if (billing.enabled) billing.start();
 */
const { createUsageReporter } = require('openvibe-sdk/usage');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GRACE_MS = 5 * 60 * 1000;               // an hour/day is aggregated only once this much of the next one passed
const GIB = 1024 * 1024 * 1024;               // a GiB in bytes: the unit gib-delivered is metered in
const GB = 1000 * 1000 * 1000;                // a GB in bytes: the unit gb-month is metered in
const MAX_CATCHUP_HOURS = 7 * 24;             // hours a late start aggregates back, newest-first (Valkey demand TTL is shorter)
const MAX_CATCHUP_DAYS = 31;
const TABLE = 'billing_readings';
const DELIVERED = 'gib-delivered';
const STORAGE = 'gb-month';
const UNKNOWN_CONTRACT = /unknown contract/;

const hourStart = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {object} o
 * @param {object} o.db          the Media database (openvibe-sdk/db)
 * @param {object} o.config      config.billing (server/config.js)
 * @param {string} [o.networkUrl] where Media's service token comes from (OV_NETWORK_INTERNAL_URL)
 * @param {{ now(): number }} [o.clock]
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.log]
 * @param {object} [o.reporter]  a ready createUsageReporter (tests); default one over `db`/`config`
 */
function createMediaBilling({ db, config, networkUrl, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, reporter: injected } = {}) {
    const intervalMs = Number(config && config.intervalMs) || 0;
    const now = () => clock.now();
    let tokenClient = null;
    if (config && config.url && config.clientSecret) {
        tokenClient = createServiceTokenClient({
            network: networkUrl, clientId: config.clientId, clientSecret: config.clientSecret,
            audience: config.audience, fetch: fetchImpl, timeoutMs: config.timeoutMs, now,
        });
    }
    const reporter = injected || createUsageReporter({
        db, service: 'media', source: 'media.billing', table: TABLE,
        billingUrl: config && config.url, tokenClient, audience: config && config.audience,
        fetchImpl, timeoutMs: (config && config.timeoutMs) || 5000, now, log,
    });
    const demand = require('./placement/demand');
    let lastError = null;

    /**
     * Queue one reading in the caller's transaction. The SDK reporter validates it against platform.usage-sample@1
     * when the pinned openvibe-contracts knows the schema; a contracts that predates it (v0.79.0 here) makes
     * validateUsageSample throw "unknown contract", which must not block the queue — the SDK's own rule is that a
     * contracts without the schema leaves the reading unchecked, not refused. Only a real validation refusal throws.
     */
    async function queue(t, reading) {
        try {
            return await reporter.record(t, reading);
        } catch (err) {
            if (!UNKNOWN_CONTRACT.test(String((err && err.message) || ''))) throw err;
            if (typeof reading.idempotency_key !== 'string' || !reading.idempotency_key) {
                throw new TypeError('billing reading: idempotency_key is required (it is the outbox key)');
            }
            const n = await t.exec(`INSERT INTO ${TABLE} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
                [reading.idempotency_key, JSON.stringify(reading), now()]);
            return n > 0;
        }
    }

    /** The closed period's row, if it was aggregated already. */
    const periodDone = (metric, periodStart) =>
        db.prepare(`SELECT readings FROM billing_periods WHERE metric = ? AND period_start = ?`).get(metric, periodStart);

    /** The last aggregated period start for `metric` (null when none). */
    const lastPeriod = async (metric) => {
        const v = await db.value(`SELECT MAX(period_start) AS p FROM billing_periods WHERE metric = ?`, [metric]);
        return v == null ? null : Number(v);
    };

    /**
     * Aggregate the closed UTC hour [periodStart, +1h) into one gib-delivered reading per (project, subject), in the
     * transaction that marks the period. Reads the hour's object reads from the placement demand rollups and the
     * objects' size_bytes; first-party and sandbox tenants are dropped before anything is recorded. A re-run of the
     * hour sees the billing_periods row and inserts nothing.
     */
    async function aggregateDeliveryHour(periodStart, { now: at = now() } = {}) {
        if (periodStart !== hourStart(periodStart)) throw new RangeError(`billing: ${periodStart} is not the start of an hour`);
        if (periodStart + HOUR_MS + GRACE_MS > at) throw new RangeError(`billing: the hour ${iso(periodStart)} has not closed`);
        const reads = await demand.readsForWindow({ from: periodStart, to: periodStart + HOUR_MS, now: at });
        let rows = [];
        if (reads.size) {
            rows = await db.prepare(`SELECT o.id, o.owner_subject, o.size_bytes, a.project_id
                    FROM media_objects o JOIN apps a ON a.app_id = o.app_id
                    WHERE o.id = ANY(?) AND o.lifecycle_status <> 'deleted'
                      AND a.env = 'production' AND a.project_id IS NOT NULL`).all([[...reads.keys()]]);
        }
        const groups = new Map();
        for (const row of rows) {
            const n = reads.get(String(row.id)) || 0;
            const bytes = n * Number(row.size_bytes || 0);
            if (!(bytes > 0)) continue;
            const gkey = `${row.project_id}\u0000${row.owner_subject || ''}`;
            const g = groups.get(gkey) || { project: String(row.project_id), subject: row.owner_subject || undefined, bytes: 0 };
            g.bytes += bytes;
            groups.set(gkey, g);
        }
        return await db.tx(async (t) => {
            if (await periodDone(DELIVERED, periodStart)) return { period: periodStart, readings: 0, created: 0, skipped: true };
            let created = 0, count = 0;
            for (const g of groups.values()) {
                const hour = iso(periodStart);
                const key = reporter.key('deliver', g.project, g.subject || '-', hour);
                const reading = reporter.sample({ idempotency_key: key, project: g.project, subject: g.subject,
                    resource: DELIVERED, provider: 'local', operation: 'deliver', quantity: g.bytes / GIB, unit: 'GiB', at: hour });
                if (await queue(t, reading)) created++;
                count++;
            }
            await t.exec(`INSERT INTO billing_periods (metric, period_start, readings, aggregated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                [DELIVERED, periodStart, count, at]);
            return { period: periodStart, readings: count, created };
        });
    }

    /**
     * Aggregate the closed UTC day [periodStart, +1d) into one gb-month reading per (project, subject, tier), in the
     * transaction that marks the day. Sums every present copy's size in media_locations by provider; first-party and
     * sandbox tenants are dropped. A re-run of the day inserts nothing.
     */
    async function aggregateStorageDay(periodStart, { now: at = now() } = {}) {
        if (periodStart !== dayStart(periodStart)) throw new RangeError(`billing: ${periodStart} is not the start of a day`);
        if (periodStart + DAY_MS + GRACE_MS > at) throw new RangeError(`billing: the day ${iso(periodStart)} has not closed`);
        const rows = await db.prepare(`SELECT a.project_id, o.owner_subject, l.provider AS tier,
                    SUM(COALESCE(l.size_bytes, o.size_bytes)) AS bytes
                FROM media_locations l JOIN media_objects o ON o.id = l.object_id JOIN apps a ON a.app_id = o.app_id
                WHERE l.state = 'present' AND o.lifecycle_status <> 'deleted'
                  AND a.env = 'production' AND a.project_id IS NOT NULL
                GROUP BY a.project_id, o.owner_subject, l.provider`).all();
        return await db.tx(async (t) => {
            if (await periodDone(STORAGE, periodStart)) return { period: periodStart, readings: 0, created: 0, skipped: true };
            const day = iso(periodStart);
            let created = 0, count = 0;
            for (const row of rows) {
                const bytes = Number(row.bytes || 0);
                if (!(bytes > 0)) continue;
                const project = String(row.project_id), subject = row.owner_subject || undefined, tier = String(row.tier);
                const key = reporter.key('store', project, subject || '-', tier, day);
                const reading = reporter.sample({ idempotency_key: key, project, subject,
                    resource: STORAGE, provider: tier, operation: 'store', quantity: bytes / GB, unit: 'GB', at: day });
                if (await queue(t, reading)) created++;
                count++;
            }
            await t.exec(`INSERT INTO billing_periods (metric, period_start, readings, aggregated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                [STORAGE, periodStart, count, at]);
            return { period: periodStart, readings: count, created };
        });
    }

    /**
     * Aggregate every closed hour and day not yet aggregated: from the one after the last marked (capped at the
     * catch-up window) through the newest closed one. The first run aggregates just the newest closed hour and day.
     */
    async function aggregateClosed({ now: at = now() } = {}) {
        let created = 0;
        const newestHour = hourStart(at - GRACE_MS) - HOUR_MS;
        const lastHour = await lastPeriod(DELIVERED);
        let fromHour = lastHour == null ? newestHour : Math.max(lastHour + HOUR_MS, newestHour - (MAX_CATCHUP_HOURS - 1) * HOUR_MS);
        for (; fromHour <= newestHour; fromHour += HOUR_MS) created += (await aggregateDeliveryHour(fromHour, { now: at })).created;

        const newestDay = dayStart(at - GRACE_MS) - DAY_MS;
        const lastDay = await lastPeriod(STORAGE);
        let fromDay = lastDay == null ? newestDay : Math.max(lastDay + DAY_MS, newestDay - (MAX_CATCHUP_DAYS - 1) * DAY_MS);
        for (; fromDay <= newestDay; fromDay += DAY_MS) created += (await aggregateStorageDay(fromDay, { now: at })).created;
        return { created };
    }

    /** One pass: aggregate the closed periods, then relay what is due. Never overlaps itself; never throws. */
    let running = null;
    function tick() {
        if (!running) running = (async () => {
            try {
                const a = await aggregateClosed();
                const s = await reporter.flush();
                return { ...a, ...s };
            } catch (err) {
                lastError = err.message;
                log.error(`[Billing] tick failed: ${err.message}`);
                return null;
            }
        })().finally(() => { running = null; });
        return running;
    }

    let timer = null;
    return {
        enabled: intervalMs > 0,
        reporting: !!tokenClient,
        reporter,
        aggregateDeliveryHour, aggregateStorageDay, aggregateClosed, tick,
        /** Queue one reading in its own transaction (tests and ad-hoc re-queues). */
        async record(reading) { return await db.tx(async (t) => queue(t, reading)); },
        /** Relay due readings now (alias of the reporter's flush). */
        send: () => reporter.flush(),
        start() {
            if (timer || !(intervalMs > 0)) return false;
            if (!tokenClient) log.warn('[Billing] OV_BILLING_URL or OV_OAUTH_CLIENT_SECRET is not set: readings are stored and stay queued');
            timer = setInterval(tick, intervalMs);
            if (timer.unref) timer.unref();
            return true;
        },
        async stop() {
            if (timer) clearInterval(timer);
            timer = null;
            if (running) await running;
            await reporter.stop();
        },
        get running() { return !!timer; },
        async status() {
            return {
                enabled: intervalMs > 0,
                reporting: !!tokenClient,
                pending: await reporter.pending(),
                rejected: await reporter.rejected(),
                aggregation: Object.fromEntries((await db.prepare(`SELECT metric, COUNT(*) AS n, MAX(period_start) AS last FROM billing_periods GROUP BY metric`).all())
                    .map((r) => [r.metric, { periods: Number(r.n), last_period_start: r.last == null ? null : Number(r.last) }])),
                last_error: lastError,
            };
        },
    };
}

module.exports = {
    createMediaBilling,
    HOUR_MS, DAY_MS, GRACE_MS, GIB, GB, TABLE, DELIVERED, STORAGE, hourStart, dayStart,
};
