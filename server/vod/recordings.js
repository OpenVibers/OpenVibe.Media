/**
 * OpenVibe.Media — recordings (docs/recordings.md): one playable video over a stream's parts.
 *
 * A recording is a native media object (kind 'asset', metadata { recording: true, virtual: true }) with a row in
 * media_recordings and its parts, in order, in media_recording_parts. It stores no bytes and has no VOD row: its HLS
 * timeline is its parts' source rows joined on every read (objects/timeline.js joinRows), through the same routes and
 * rules as any object (/o/<id>/master.m3u8), and a clip may sit on it (a window in recording time, across a join too).
 * The first part is the video's public face: its VOD row stays, lists hide the parts after it (db._vodConds), and its
 * answer carries `recording` so an app plays and counts the whole.
 *
 *   setParts(appId, key, parts, { title, state })   the recording for an app's key, with these parts (idempotent);
 *                                                    fewer than two parts: none (a part alone is its own video)
 *   forVod(appId, vodId)                            the recording a VOD is part of, with its place in it, or null
 *   get(appId, objectId) / byKey(appId, key)        a recording with its parts
 *   rowsOf(obj)                                     the joined source rows of a recording object ([] when a part has
 *                                                    no timeline yet: a recording plays whole or not at all)
 *   summaries(vodIds)                               the `recording` field of many VODs in one query (list answers)
 *   syncPart(vodId, { visibility, title })          a part's visibility is every part's and the recording's; the first
 *                                                    part's title is the recording's
 *   router                                          GET/PUT /api/v1/:app/recordings/:key, POST …/:key/close,
 *                                                    GET /api/v1/:app/recordings/object/:id
 */
'use strict';

const express = require('express');
const db = require('../db/database');
const model = require('../objects/model');
const { tenantAuth } = require('../auth');

const KEY = /^[A-Za-z0-9:_.-]{1,120}$/;
const MAX_PARTS = 200;

const isRecording = (obj) => !!obj && obj.kind === 'asset' && model.parseJson(obj.metadata, {}).recording === true;

async function partsOf(objectId) {
    return await db.all(`SELECT p.seq, p.vod_id, p.gap_before_ms, p.stream_offset_ms, v.object_id, v.duration_seconds, v.title, v.visibility,
            v.thumbnail_url, v.created_at
        FROM media_recording_parts p LEFT JOIN vods v ON v.id = p.vod_id
        WHERE p.recording_object_id = ? ORDER BY p.seq`, [objectId]);
}

/** Each part's length in ms: its timeline's (exact), else its row's duration. */
async function partLengths(parts) {
    const ids = parts.map((p) => p.object_id).filter(Boolean);
    const spans = new Map();
    if (ids.length) {
        for (const r of await db.all(`SELECT object_id, MIN(start_ms) AS a, MAX(end_ms) AS b FROM media_timeline
                WHERE rendition = 'source' AND seq > 0 AND object_id = ANY(?) GROUP BY object_id`, [ids])) {
            spans.set(r.object_id, Number(r.b) - Number(r.a));
        }
    }
    return parts.map((p) => (spans.has(p.object_id) ? spans.get(p.object_id) : Math.round(Number(p.duration_seconds || 0) * 1000)));
}

/** A recording's public answer: its object id, state, length and parts with their place (recording time, ms). */
async function present(rec) {
    if (!rec) return null;
    const parts = await partsOf(rec.object_id);
    const lengths = await partLengths(parts);
    let at = 0;
    const out = parts.map((p, i) => {
        const part = { seq: p.seq, vod_id: Number(p.vod_id), start_ms: at, duration_ms: lengths[i], gap_before_ms: Number(p.gap_before_ms) || 0,
            ...(p.stream_offset_ms != null && { stream_offset_ms: Number(p.stream_offset_ms) }) };
        at += lengths[i];
        return part;
    });
    const obj = await model.getObject(rec.object_id);
    const hls = await require('../objects/hls').discoveryForObject(obj).catch(() => null);
    return {
        id: rec.object_id, key: rec.group_key, state: rec.state, duration_ms: at, duration_seconds: Math.round(at / 1000),
        vod_id: out.length ? out[0].vod_id : null, parts: out, ...(hls || {}),
        created_at: rec.created_at, updated_at: rec.updated_at,
    };
}

async function byKey(appId, key) {
    const rec = await db.get('SELECT * FROM media_recordings WHERE app_id = ? AND group_key = ?', [appId, String(key)]);
    return rec ? await present(rec) : null;
}

async function get(appId, objectId) {
    const rec = await db.get('SELECT * FROM media_recordings WHERE app_id = ? AND object_id = ?', [appId, String(objectId)]);
    return rec ? await present(rec) : null;
}

async function forVod(appId, vodId) {
    const p = await db.get(`SELECT r.* FROM media_recording_parts p JOIN media_recordings r ON r.object_id = p.recording_object_id
        WHERE p.vod_id = ? AND r.app_id = ?`, [Number(vodId), appId]);
    if (!p) return null;
    const rec = await present(p);
    const part = rec.parts.find((x) => x.vod_id === Number(vodId)) || null;
    return { recording: rec, part };
}

/**
 * The `recording` field of VOD answers, for many VODs in two queries: { recording_id, seq, parts, start_ms, duration_ms,
 * first_vod_id }. duration_ms is the whole recording's (its parts' row durations; the detail answer is exact).
 */
async function summaries(vodIds) {
    const ids = [...new Set((vodIds || []).map(Number).filter(Number.isFinite))];
    const out = new Map();
    if (!ids.length) return out;
    const mine = await db.all('SELECT recording_object_id, vod_id FROM media_recording_parts WHERE vod_id = ANY(?)', [ids]);
    if (!mine.length) return out;
    const recs = [...new Set(mine.map((r) => r.recording_object_id))];
    const all = await db.all(`SELECT p.recording_object_id, p.seq, p.vod_id, v.duration_seconds FROM media_recording_parts p
        LEFT JOIN vods v ON v.id = p.vod_id WHERE p.recording_object_id = ANY(?) ORDER BY p.recording_object_id, p.seq`, [recs]);
    const byRec = new Map();
    for (const r of all) { if (!byRec.has(r.recording_object_id)) byRec.set(r.recording_object_id, []); byRec.get(r.recording_object_id).push(r); }
    for (const m of mine) {
        const parts = byRec.get(m.recording_object_id) || [];
        let at = 0, start = 0, seq = 0;
        for (const p of parts) {
            if (Number(p.vod_id) === Number(m.vod_id)) { start = at; seq = p.seq; }
            at += Math.round(Number(p.duration_seconds || 0) * 1000);
        }
        out.set(Number(m.vod_id), { recording_id: m.recording_object_id, seq, parts: parts.length, start_ms: start, duration_ms: at,
            first_vod_id: parts.length ? Number(parts[0].vod_id) : null });
    }
    return out;
}

// The joined rows of a recording, kept a short while: every segment request of a player reads them. setParts clears
// its recording's entry; a part re-cut or packed shows within ROWS_TTL_MS.
const ROWS_TTL_MS = 20000;
const ROWS_MAX = 200;
const rowsCache = new Map();   // object id → { at, rows }

/** The joined source rows of a recording object, or [] (not a recording, a part missing, a part with no timeline). */
async function rowsOf(obj) {
    if (!isRecording(obj)) return [];
    const hit = rowsCache.get(obj.id);
    if (hit && Date.now() - hit.at < ROWS_TTL_MS) return hit.rows;
    const rows = await joinedRows(obj);
    if (rows.length) {
        if (rowsCache.size >= ROWS_MAX) rowsCache.delete(rowsCache.keys().next().value);
        rowsCache.set(obj.id, { at: Date.now(), rows });
    }
    return rows;
}

async function joinedRows(obj) {
    const timeline = require('../objects/timeline');
    const parts = await partsOf(obj.id);
    if (parts.length < 2 || parts.some((p) => !p.object_id)) return [];
    const rows = [];
    for (const p of parts) rows.push(await timeline.list(p.object_id, timeline.SOURCE));
    if (rows.some((r) => !r.some((x) => Number(x.seq) > 0))) {
        // A part not cut yet: queue it (idempotent) and answer nothing until every part plays.
        const hls = require('../objects/hls');
        for (const [i, r] of rows.entries()) if (!r.some((x) => Number(x.seq) > 0)) await hls.queueCmafOnce(obj.app_id, parts[i].object_id);
        return [];
    }
    return timeline.joinRows(rows);
}

/** The title a recording shows: the first part's, without a " (Part 1)" the app may have added. */
const baseTitle = (t) => String(t || 'Recording').replace(/\s*\(part \d+\)\s*$/i, '').slice(0, 200) || 'Recording';

/**
 * Make the recording for (appId, key) hold exactly `parts` ([{ vod_id, gap_before_ms?, stream_offset_ms? }], in order).
 * Every VOD must be this app's, finished or recording, and in no other recording. Two or more parts: the recording is
 * created or updated; fewer: an existing one is removed (its object deleted) and nothing is answered. Idempotent.
 */
async function setParts(appId, key, parts, { title = null, state = null } = {}) {
    if (!KEY.test(String(key || ''))) throw Object.assign(new Error('the key is 1-120 letters, digits and : _ . -'), { status: 400, code: 'media.recording.bad_key' });
    const list = (parts || []).map((p) => (typeof p === 'object' && p ? p : { vod_id: p }))
        .map((p) => ({ vod_id: Number(p.vod_id), gap_before_ms: Math.max(0, Math.round(Number(p.gap_before_ms) || 0)),
            stream_offset_ms: p.stream_offset_ms == null || !Number.isFinite(Number(p.stream_offset_ms)) ? null : Math.round(Number(p.stream_offset_ms)) }));
    if (list.length > MAX_PARTS) throw Object.assign(new Error(`at most ${MAX_PARTS} parts`), { status: 400, code: 'media.recording.too_many_parts' });
    if (list.some((p) => !Number.isFinite(p.vod_id)) || new Set(list.map((p) => p.vod_id)).size !== list.length) {
        throw Object.assign(new Error('parts are distinct VOD ids'), { status: 400, code: 'media.recording.bad_parts' });
    }
    const vods = list.length ? await db.all('SELECT id, app_id, object_id, title, visibility, user_id, clips_only FROM vods WHERE id = ANY(?)', [list.map((p) => p.vod_id)]) : [];
    const byId = new Map(vods.map((v) => [Number(v.id), v]));
    for (const p of list) {
        const v = byId.get(p.vod_id);
        if (!v || v.app_id !== appId || v.clips_only) throw Object.assign(new Error(`VOD ${p.vod_id} is not one of this app's videos`), { status: 404, code: 'media.recording.vod_not_found' });
    }
    const raw = db.getDb();
    const objectId = await raw.tx(async () => {
        const rec = await db.get('SELECT * FROM media_recordings WHERE app_id = ? AND group_key = ? FOR UPDATE', [appId, String(key)]);
        const taken = list.length ? await db.all('SELECT vod_id, recording_object_id FROM media_recording_parts WHERE vod_id = ANY(?)', [list.map((p) => p.vod_id)]) : [];
        const other = taken.find((t) => !rec || t.recording_object_id !== rec.object_id);
        if (other) throw Object.assign(new Error(`VOD ${other.vod_id} is part of another recording`), { status: 409, code: 'media.recording.part_taken' });
        if (list.length < 2) {
            if (rec) {
                await db.run('DELETE FROM media_recordings WHERE object_id = ?', [rec.object_id]);
                await model.updateObject(rec.object_id, { lifecycle_status: 'deleted', deleted_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
            }
            return null;
        }
        const first = byId.get(list[0].vod_id);
        const metadata = { recording: true, virtual: true, group_key: String(key), title: title ? String(title).slice(0, 200) : baseTitle(first.title) };
        let id = rec && rec.object_id;
        if (!id) {
            id = await model.createObject({ app_id: appId, kind: 'asset', visibility: first.visibility || 'public', lifecycle_status: 'ready',
                owner_app: appId, owner_user_id: first.user_id ?? null, mime_type: 'application/vnd.apple.mpegurl', metadata });
            await db.run('INSERT INTO media_recordings (object_id, app_id, group_key, state) VALUES (?, ?, ?, ?)', [id, appId, String(key), state === 'closed' ? 'closed' : 'open']);
        } else {
            const obj = await model.getObject(id);
            await model.updateObject(id, { metadata: { ...model.parseJson(obj.metadata, {}), ...metadata }, visibility: first.visibility || obj.visibility });
            await db.run("UPDATE media_recordings SET state = COALESCE(?, state), updated_at = ov_now() WHERE object_id = ?", [state === 'closed' || state === 'open' ? state : null, id]);
        }
        await db.run('DELETE FROM media_recording_parts WHERE recording_object_id = ?', [id]);
        for (const [i, p] of list.entries()) {
            await db.run('INSERT INTO media_recording_parts (recording_object_id, seq, vod_id, gap_before_ms, stream_offset_ms) VALUES (?, ?, ?, ?, ?)',
                [id, i + 1, p.vod_id, p.gap_before_ms, p.stream_offset_ms]);
        }
        return id;
    });
    for (const id of [...rowsCache.keys()]) rowsCache.delete(id);   // a recording's parts changed: read them again
    return objectId ? await get(appId, objectId) : null;
}

async function close(appId, key) {
    await db.run("UPDATE media_recordings SET state = 'closed', updated_at = ov_now() WHERE app_id = ? AND group_key = ?", [appId, String(key)]);
    return await byKey(appId, key);
}

/**
 * A part changed: its visibility is the whole recording's (every part and the recording object follow; the app sets it
 * on one), and the first part's title is the recording's.
 */
async function syncPart(vodId, { visibility, title } = {}) {
    const p = await db.get('SELECT recording_object_id, seq FROM media_recording_parts WHERE vod_id = ?', [Number(vodId)]);
    if (!p) return;
    if (visibility !== undefined) {
        const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'public';
        const others = await db.all('SELECT vod_id FROM media_recording_parts WHERE recording_object_id = ? AND vod_id <> ?', [p.recording_object_id, Number(vodId)]);
        for (const o of others) await db.setVodVisibility(o.vod_id, vis);   // the row and its object together
        await model.updateObject(p.recording_object_id, { visibility: vis });
    }
    if (title !== undefined && Number(p.seq) === 1) {
        const obj = await model.getObject(p.recording_object_id);
        await model.updateObject(p.recording_object_id, { metadata: { ...model.parseJson(obj.metadata, {}), title: baseTitle(title) } });
    }
}

// ── Routes (/api/v1/:app/recordings) ──
const router = express.Router({ mergeParams: true });
const fail = (res, err) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[Recordings]', err && err.message);
    return res.status(500).json({ error: 'Failed' });
};

router.get('/object/:id', tenantAuth({ verb: 'read' }), async (req, res) => {
    try {
        const rec = await get(req.appId, req.params.id);
        return rec ? res.json(rec) : res.status(404).json({ error: 'Recording not found', code: 'media.recording.not_found' });
    } catch (err) { return fail(res, err); }
});

router.get('/:key', tenantAuth({ verb: 'read' }), async (req, res) => {
    try {
        const rec = await byKey(req.appId, req.params.key);
        return rec ? res.json(rec) : res.status(404).json({ error: 'Recording not found', code: 'media.recording.not_found' });
    } catch (err) { return fail(res, err); }
});

// Body: { parts: [vod_id | { vod_id, gap_before_ms?, stream_offset_ms? }], title?, state? }. Answers the recording, or
// { recording: null } when fewer than two parts were given (a part alone is its own video).
router.put('/:key', tenantAuth({ verb: 'write' }), async (req, res) => {
    if (req.authType !== 'app') return res.status(403).json({ error: 'only the owning app groups its videos' });
    try {
        const b = req.body || {};
        const rec = await setParts(req.appId, req.params.key, Array.isArray(b.parts) ? b.parts : [], { title: b.title || null, state: b.state || null });
        return res.json(rec || { recording: null });
    } catch (err) { return fail(res, err); }
});

router.post('/:key/close', tenantAuth({ verb: 'write' }), async (req, res) => {
    if (req.authType !== 'app') return res.status(403).json({ error: 'only the owning app closes a recording' });
    try {
        const rec = await close(req.appId, req.params.key);
        return rec ? res.json(rec) : res.status(404).json({ error: 'Recording not found', code: 'media.recording.not_found' });
    } catch (err) { return fail(res, err); }
});

module.exports = { isRecording, setParts, close, get, byKey, forVod, summaries, rowsOf, syncPart, present, baseTitle, router };
