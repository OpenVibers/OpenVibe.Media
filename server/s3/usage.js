'use strict';
/**
 * Per-zone usage on Media's S3 surface (ADR-031 section 8; openvibe-contracts media.usage.recorded@1, which is
 * common.usage-recorded@1). Media is the only counter: per zone and closed UTC hour it stores one rollup per series as
 * its own event, and Network (the project's usage) and Zone (its usage view) add them up.
 *
 *   track(req, res)     a request that reached a zone (req.s3.zone): counted when its answer finishes
 *   sample()            each active zone's live bytes for this minute, added as byte_hours (bytes / 60 a minute)
 *   flush()             the counts kept in memory are added to media_s3_usage (every 30 s, and at shutdown)
 *   emit()              every closed hour not sent yet, or corrected since (revision), goes to the outbox as
 *                       media.usage.recorded, in the transaction that marks it sent
 *
 * The series (capability, unit): stored bytes (media.object.upload, byte_hours); writes (media.object.upload and
 * media.object.delete, requests); lists (media.object.list, requests); reads (media.object.read, requests and
 * egress_bytes). A refused or failed request counts in `errors`, by its S3 code as media.s3.<snake_case>. Each rollup
 * names its zone twice: resource is the zone's OVRN and dimension its id in lowercase. Nothing here names who sent a
 * request, or a key, an object key or an address: rollups are counts, never money (Billing never reads them).
 */
const db = require('../db/database');
const events = require('../events');

const HOUR_MS = 3600 * 1000;
const MAX_CODES = 20;
const MAX_SAMPLES = 10;
const hourOf = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const parse = (v, d) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const snake = (code) => String(code).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();

let pending = new Map(); // zone|window|capability|unit → { zone, window, capability, unit, quantity, errors, codes, samples }

function bucket(zone, capability, unit, now) {
    const window = hourOf(now);
    const k = `${zone.id}|${window}|${capability}|${unit}`;
    let b = pending.get(k);
    if (!b) {
        b = { zone: { id: zone.id, project_id: zone.project_id, env: zone.env }, window, capability, unit, quantity: 0, errors: 0, codes: {}, samples: [] };
        pending.set(k, b);
    }
    return b;
}

/** Add to one series of a zone now: quantity units, and an error when code is set. */
function count(zone, capability, unit, quantity, { code = null, status = null, now = Date.now() } = {}) {
    if (!zone || !zone.id) return;
    const b = bucket(zone, capability, unit, now);
    b.quantity += Math.max(0, Math.round(quantity || 0));
    if (code) {
        b.errors++;
        const c = `media.s3.${snake(code)}`;
        b.codes[c] = (b.codes[c] || 0) + 1;
        b.samples.unshift({ at: new Date(now).toISOString(), code: c, ...(status ? { status } : {}) });
        b.samples.length = Math.min(b.samples.length, MAX_SAMPLES);
    }
}

/** The capability a request to a zone counts against, from its method and query (hasKey: an object, not the bucket). */
function capabilityOf(req, hasKey) {
    const m = req.method;
    const q = req.query || {};
    if (!hasKey) {
        if (m === 'POST' && q.delete !== undefined) return 'media.object.delete';
        if ((m === 'GET' && q.location === undefined) || m === 'HEAD') return 'media.object.list';
        return null;
    }
    if (m === 'PUT' || m === 'POST') return 'media.object.upload';
    if (m === 'DELETE') return 'media.object.delete';
    if (m === 'GET' && q.uploadId !== undefined) return 'media.object.list';
    if (m === 'GET' || m === 'HEAD') return 'media.object.read';
    return null;
}

/** Count a request to a zone when its answer is sent (req.s3.zone and req.s3.hasKey are set by the dispatcher). */
function track(req, res) {
    res.once('finish', () => {
        const s3 = req.s3;
        if (!s3 || !s3.zone) return;
        const capability = capabilityOf(req, s3.hasKey);
        if (!capability) return;
        const failed = res.statusCode >= 400;
        const code = failed ? (res.locals.s3code || `http_${res.statusCode}`) : null;
        count(s3.zone, capability, 'requests', 1, { code, status: failed ? res.statusCode : null });
        if (capability === 'media.object.read' && req.method === 'GET' && !failed) {
            count(s3.zone, capability, 'egress_bytes', Number(res.getHeader('content-length')) || 0);
        }
    });
}

/** Each active zone's live bytes, as one minute of byte_hours (bytes / 60). */
async function sample({ now = Date.now() } = {}) {
    const zones = require('./zones');
    const rows = await db.all("SELECT * FROM media_zones WHERE state = 'active'");
    for (const z of rows) {
        const st = await zones.status(z, { now });
        if (st.stored_bytes > 0) count(z, 'media.object.upload', 'byte_hours', st.stored_bytes / 60, { now });
    }
    return rows.length;
}

/** Add what is kept in memory to media_s3_usage. A window already sent gets a new revision (it is re-sent). */
async function flush() {
    if (!pending.size) return 0;
    const batch = [...pending.values()];
    pending = new Map();
    try {
        await db.getDb().tx(async () => {
            for (const b of batch) {
                const cur = await db.get(`SELECT * FROM media_s3_usage WHERE zone_id = ? AND window_start = ? AND capability = ? AND unit = ?`,
                    [b.zone.id, b.window, b.capability, b.unit]);
                if (!cur) {
                    await db.run(`INSERT INTO media_s3_usage (zone_id, project_id, env, window_start, capability, unit, quantity, errors, error_codes, samples, revision, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
                    [b.zone.id, b.zone.project_id, b.zone.env, b.window, b.capability, b.unit, b.quantity, b.errors,
                        JSON.stringify(topCodes(b.codes)), JSON.stringify(b.samples), Date.now()]);
                    continue;
                }
                const codes = parse(cur.error_codes, {});
                for (const [c, n] of Object.entries(b.codes)) codes[c] = (codes[c] || 0) + n;
                const samples = [...b.samples, ...parse(cur.samples, [])].slice(0, MAX_SAMPLES);
                const sent = cur.sent_revision != null && Number(cur.sent_revision) >= Number(cur.revision);
                await db.run(`UPDATE media_s3_usage SET quantity = quantity + ?, errors = errors + ?, error_codes = ?, samples = ?,
                    revision = revision + ?, updated_at = ? WHERE zone_id = ? AND window_start = ? AND capability = ? AND unit = ?`,
                [b.quantity, b.errors, JSON.stringify(topCodes(codes)), JSON.stringify(samples), sent ? 1 : 0, Date.now(),
                    b.zone.id, b.window, b.capability, b.unit]);
            }
        });
    } catch (err) {
        // Put the counts back: the next flush tries again.
        for (const b of batch) {
            const t = bucket(b.zone, b.capability, b.unit, b.window);
            t.quantity += b.quantity;
            t.errors += b.errors;
            for (const [c, n] of Object.entries(b.codes)) t.codes[c] = (t.codes[c] || 0) + n;
            t.samples = [...b.samples, ...t.samples].slice(0, MAX_SAMPLES);
        }
        throw err;
    }
    return batch.length;
}

function topCodes(codes) {
    return Object.fromEntries(Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, MAX_CODES));
}

/** The rollup a stored row becomes (common.usage-recorded@1). */
function rollupOf(row) {
    const codes = parse(row.error_codes, {});
    const samples = parse(row.samples, []);
    const start = Number(row.window_start);
    const out = {
        project_id: row.project_id, env: row.env, capability: row.capability,
        resource: `ovrn:zone:${row.project_id}:object-zone/${row.zone_id}`, dimension: String(row.zone_id).toLowerCase(),
        unit: row.unit, window: 'hour', window_start: new Date(start).toISOString(), window_end: new Date(start + HOUR_MS).toISOString(),
        quantity: Number(row.quantity), errors: Number(row.errors),
    };
    if (Object.keys(codes).length) out.error_codes = codes;
    if (samples.length) out.samples = samples;
    if (Number(row.revision) > 1) out.revision = Number(row.revision);
    return out;
}

/** Store every closed hour not sent yet (or corrected since) as media.usage.recorded. */
async function emit({ now = Date.now(), limit = 500 } = {}) {
    const rows = await db.all(`SELECT * FROM media_s3_usage WHERE window_start < ? AND (sent_revision IS NULL OR sent_revision < revision)
        ORDER BY window_start, zone_id, capability, unit LIMIT ?`, [hourOf(now), limit]);
    let sent = 0;
    for (const row of rows) {
        const rollup = rollupOf(row);
        const v = events.checkUsage(rollup);
        if (!v.valid) {
            console.error(`[S3] usage rollup ${row.zone_id} ${rollup.window_start} ${row.capability}/${row.unit} does not match media.usage.recorded@1 and stays unsent: ${v.errors}`);
            continue;
        }
        await db.getDb().tx(async () => {
            const env = await events.recordUsage(rollup);
            await db.run(`UPDATE media_s3_usage SET sent_revision = ? WHERE zone_id = ? AND window_start = ? AND capability = ? AND unit = ?`,
                [Number(row.revision), row.zone_id, row.window_start, row.capability, row.unit]);
            if (env) sent++;
        });
    }
    return sent;
}

/** Rows older than keepDays (the events carry them on; Zone and Network keep their own sums). */
async function prune({ now = Date.now(), keepDays = 40 } = {}) {
    const r = await db.run('DELETE FROM media_s3_usage WHERE window_start < ? AND sent_revision IS NOT NULL AND sent_revision >= revision',
        [now - keepDays * 24 * HOUR_MS]);
    return r && r.changes ? r.changes : 0;
}

function _reset() { pending = new Map(); }
function _pending() { return pending; }

module.exports = { track, count, capabilityOf, sample, flush, emit, prune, rollupOf, snake, _reset, _pending };
