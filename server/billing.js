'use strict';
/**
 * Media's storage usage readings → OpenVibe.Billing (plan T5 step 14, Media slice).
 *
 * Media emits one platform.usage-sample@1 metric, gb-month, the storage metric the platform.rate-card@1 contract
 * names for it:
 *
 *   gb-month       the bytes stored for one closed UTC day, per (project, subject, tier): every present copy in
 *                  media_locations, once a day ("daily partition"), in GB. resource 'gb-month', provider the tier
 *                  (local/b2/r2), unit 'GB', operation 'store'. Each daily reading carries that day's share of a
 *                  GB-month — bytes / GB / (days in that UTC month) — so a month of daily readings sums to one
 *                  GB-month. A location more than one object names (F3.4) is counted once, billed to the oldest
 *                  object naming it.
 *
 * gib-delivered is deliberately not emitted. demand.record() counts route() calls, not bytes: reads × size_bytes
 * would bill aborted downloads and range reads in full, would bill presigned B2/R2 redirects Media never serves,
 * and never sees HLS segment reads. It comes back once responses are metered by the bytes actually written
 * (sendSlice/streamFileWithRange) and redirected reads are metered by CDN logs. Nothing here bills delivery.
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

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;               // a day is aggregated only once this much of the next one passed
const GB = 1000 * 1000 * 1000;                // a GB in bytes: the unit gb-month is metered in
const TABLE = 'billing_readings';
const STORAGE = 'gb-month';
const UNKNOWN_CONTRACT = /unknown contract/;

const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const iso = (ms) => new Date(ms).toISOString();
/** Days in the UTC month containing `ms`: the divisor that turns a day's bytes into its share of a GB-month. */
function daysInMonth(ms) { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }

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

    /**
     * Aggregate the closed UTC day [periodStart, +1d) into one gb-month reading per (project, subject, tier), in the
     * transaction that marks the day. A location is counted once even when several objects name it (F3.4): the
     * subquery keeps, per storage identity (provider + key), the oldest non-deleted object naming it and that
     * location's bytes, so the sum bills the bytes once to that object's owner. First-party and sandbox tenants are
     * dropped. Each reading carries the day's share of a GB-month (bytes / GB / days in the UTC month), so a month
     * of daily readings sums to one GB-month. A re-run of the day inserts nothing.
     */
    async function aggregateStorageDay(periodStart, { now: at = now() } = {}) {
        if (periodStart !== dayStart(periodStart)) throw new RangeError(`billing: ${periodStart} is not the start of a day`);
        if (periodStart + DAY_MS + GRACE_MS > at) throw new RangeError(`billing: the day ${iso(periodStart)} has not closed`);
        const rows = await db.prepare(`WITH named AS (
                    SELECT DISTINCT ON (l.provider, l.key)
                           l.provider AS tier, COALESCE(l.size_bytes, o.size_bytes) AS bytes, o.owner_subject, o.app_id
                    FROM media_locations l JOIN media_objects o ON o.id = l.object_id
                    WHERE l.state = 'present' AND o.lifecycle_status <> 'deleted'
                    ORDER BY l.provider, l.key, o.created_at, o.id
                )
                SELECT a.project_id, n.owner_subject, n.tier, SUM(n.bytes) AS bytes
                FROM named n JOIN apps a ON a.app_id = n.app_id
                WHERE a.env = 'production' AND a.project_id IS NOT NULL
                GROUP BY a.project_id, n.owner_subject, n.tier`).all();
        const days = daysInMonth(periodStart);
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
                    resource: STORAGE, provider: tier, operation: 'store', quantity: (bytes / GB) / days, unit: 'GB', at: day });
                if (await queue(t, reading)) created++;
                count++;
            }
            await t.exec(`INSERT INTO billing_periods (metric, period_start, readings, aggregated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                [STORAGE, periodStart, count, at]);
            return { period: periodStart, readings: count, created };
        });
    }

    /**
     * Aggregate the newest closed UTC day. The storage query reads media_locations' current state, so a past day can
     * never be reconstructed later: only this day is aggregated, and a day missed while the service was down is
     * simply not billed (a reading must not claim today's state for an older day).
     */
    async function aggregateClosed({ now: at = now() } = {}) {
        const newestDay = dayStart(at - GRACE_MS) - DAY_MS;
        const r = await aggregateStorageDay(newestDay, { now: at });
        return { created: r.created };
    }

    /** One pass: aggregate the newest closed day, then relay what is due. Never overlaps itself; never throws. */
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
        aggregateStorageDay, aggregateClosed, tick,
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
    DAY_MS, GRACE_MS, GB, TABLE, STORAGE, dayStart,
};
