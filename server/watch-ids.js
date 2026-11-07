/**
 * OpenVibe.Media — watch ids (plan track U, 2026-11-07).
 *
 * A VOD and a clip are watched at openvibe.video/watch?v=<watch id>, YouTube's shape: 11 characters of URL-safe base64
 * from 8 random bytes (64 bits), so a page cannot be found by counting. Media owns VODs and clips, so Media mints the
 * id: at insert for every new row (server/db/database.js createVod/createClip), and in batches for rows that predate
 * this (backfill, below, only where watch_id IS NULL, idempotent).
 *
 * One id space across the two tables. Each table has its own partial unique index (migrations/0024_watch_ids.sql), and
 * mint() checks both tables before it answers, so the same id is never handed to a VOD and a clip — resolve() then has
 * one answer to give, never a choice.
 */
'use strict';

const crypto = require('crypto');

const WATCH_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const BACKFILL_BATCH = 500;
const MINT_ATTEMPTS = 5;

/** A fresh watch id: 64 random bits as 11 URL-safe base64 characters (never derived from the numeric id). */
function mint() {
    return crypto.randomBytes(8).toString('base64url');
}

/** Is this a watch id's shape? (The format check a route does before it queries anything.) */
function isWatchId(v) {
    return WATCH_ID_RE.test(String(v || ''));
}

/** The database handle, late-bound (a test process opens it through test/helpers/pg-preload.mjs). */
function db() {
    return require('./db/database');
}

/**
 * A watch id no VOD and no clip holds yet. Checks both tables, so the two tables share one id space; retries on the
 * vanishing chance of a clash. Throws after MINT_ATTEMPTS rather than answer a duplicate.
 */
async function mintUnique(query = db()) {
    for (let i = 0; i < MINT_ATTEMPTS; i++) {
        const id = mint();
        const taken = await query.get(
            'SELECT 1 FROM vods WHERE watch_id = ? UNION ALL SELECT 1 FROM clips WHERE watch_id = ? LIMIT 1',
            [id, id]);
        if (!taken) return id;
    }
    throw new Error('could not mint a watch id that is free in both vods and clips');
}

/**
 * The row's watch id, minting and storing one when it has none yet.
 *
 * The boot backfill fills existing rows in the background, but a row read before it is reached (or written by an older
 * release mid-deploy) still has an id to answer with: this fills it, once, with the same "only where NULL" write the
 * backfill uses, so a concurrent caller cannot overwrite an id already written. A restore drill reads its copy as it
 * is and writes nothing, so there it answers null rather than fail the read.
 */
async function ensure(kind, id, query = db()) {
    const table = kind === 'clip' ? 'clips' : 'vods';
    const row = await query.get(`SELECT watch_id FROM ${table} WHERE id = ?`, [id]);
    if (!row) return null;
    if (row.watch_id) return row.watch_id;
    if (require('./drill').enabled) return null;
    const minted = await mintUnique(query);
    await query.run(`UPDATE ${table} SET watch_id = ? WHERE id = ? AND watch_id IS NULL`, [minted, id]);
    const after = await query.get(`SELECT watch_id FROM ${table} WHERE id = ?`, [id]);
    return after ? after.watch_id || null : null;
}

/**
 * Where a watch id points: { kind: 'vod' | 'clip', id: <numeric id> } or null.
 *
 * Visibility is the caller's business and unchanged by this: a private row still resolves here (the route answers it
 * exactly as it answered its number before), and an unlisted row is reachable only by its watch id, never listed.
 */
async function resolve(watchId, query = db()) {
    if (!isWatchId(watchId)) return null;
    const vod = await query.get('SELECT id FROM vods WHERE watch_id = ?', [watchId]);
    if (vod) return { kind: 'vod', id: Number(vod.id) };
    const clip = await query.get('SELECT id FROM clips WHERE watch_id = ?', [watchId]);
    if (clip) return { kind: 'clip', id: Number(clip.id) };
    return null;
}

/** The watch id of one row, or null when it has none yet (a read before the backfill reached it). */
async function of(kind, id, query = db()) {
    const table = kind === 'clip' ? 'clips' : 'vods';
    const row = await query.get(`SELECT watch_id FROM ${table} WHERE id = ?`, [id]);
    return row ? row.watch_id || null : null;
}

/**
 * Fill the watch ids of rows that have none, in bounded batches, and say how many were filled.
 *
 * Idempotent and resumable: it only ever writes where watch_id IS NULL, so running it again after a partial pass (or
 * twice at once) fills what is left and changes nothing already judged. `limit` bounds one call (the boot backfill
 * passes a batch; a job or the CLI loops until `remaining` is 0). Each batch is its own transaction, so nothing holds a
 * lock over a whole table.
 *
 * Returns { vods, clips, remaining, filled }.
 */
async function backfill({ limit = BACKFILL_BATCH, query = db(), log = null } = {}) {
    const filled = { vods: 0, clips: 0 };
    let budget = Math.max(0, Number(limit) || 0);
    for (const [kind, table] of [['vod', 'vods'], ['clip', 'clips']]) {
        if (!budget) break;
        const rows = await query.all(
            `SELECT id FROM ${table} WHERE watch_id IS NULL ORDER BY id LIMIT ?`, [budget]);
        for (const row of rows) {
            // The id is chosen per row and written only where the row is still empty: two callers racing cannot both
            // fill the same row, and neither overwrites an id another caller just wrote.
            const id = await mintUnique(query);
            const out = await query.run(
                `UPDATE ${table} SET watch_id = ? WHERE id = ? AND watch_id IS NULL`, [id, row.id]);
            if (out && Number(out.changes) > 0) filled[table] += 1;
        }
        budget = Math.max(0, budget - rows.length);
    }
    const left = async (table) => Number((await query.get(`SELECT COUNT(*) AS n FROM ${table} WHERE watch_id IS NULL`))?.n) || 0;
    const remaining = await left('vods') + await left('clips');
    if (log && (filled.vods || filled.clips)) {
        log.log(`[WatchId] backfilled ${filled.vods} VOD(s) and ${filled.clips} clip(s); ${remaining} row(s) still without one`);
    }
    return { vods: filled.vods, clips: filled.clips, filled: filled.vods + filled.clips, remaining };
}

/**
 * Fill every row that has none, batch after batch, until none is left. The boot calls this once; a big estate is
 * filled in bounded transactions rather than one long write. Returns the totals of this run.
 */
async function backfillAll({ batch = BACKFILL_BATCH, query = db(), log = null, maxBatches = 10_000 } = {}) {
    const total = { vods: 0, clips: 0, filled: 0, remaining: 0 };
    for (let i = 0; i < maxBatches; i++) {
        const out = await backfill({ limit: batch, query, log: null });
        total.vods += out.vods; total.clips += out.clips; total.filled += out.filled; total.remaining = out.remaining;
        if (log && out.filled) log.log(`[WatchId] ${total.filled} row(s) filled so far, ${out.remaining} left`);
        if (!out.filled) break;   // nothing left, or a batch that could fill nothing (do not spin)
    }
    return total;
}

module.exports = { mint, mintUnique, isWatchId, resolve, of, ensure, backfill, backfillAll, WATCH_ID_RE, BACKFILL_BATCH };
