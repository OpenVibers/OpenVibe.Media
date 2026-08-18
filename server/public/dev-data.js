/**
 * OpenVibe.Media — public dev-data API (transcripts, AI overview timelines,
 * chat insight). Companion to the live frame API: same selector grammar
 * (slot id / slot slug / @username), same cache-as-rate-limit philosophy,
 * JSON out, CORS-open.
 *
 * Media owns per-VOD AI data (ai_overview / ai_transcript); streamer-level
 * extras (chat insight, streamer overview, stream memories) are app-side and
 * fetched over loopback from the app's public API, cached here.
 */
'use strict';

const db = require('../db/database');
const frames = require('../thumbnails/live-frame-service');

const CACHE_TTL_MS = 30_000;
const _cache = new Map();      // key → { at, out }
const _inFlight = new Map();   // key → Promise

function cached(key, fn) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.out);
    if (_inFlight.has(key)) return _inFlight.get(key);
    const p = Promise.resolve().then(fn)
        .then((out) => {
            if (_cache.size > 500) {
                const cutoff = Date.now() - CACHE_TTL_MS;
                for (const [k, v] of _cache) { if (v.at < cutoff) _cache.delete(k); }
            }
            _cache.set(key, { at: Date.now(), out });
            _inFlight.delete(key);
            return out;
        })
        .catch((err) => { _inFlight.delete(key); throw err; });
    _inFlight.set(key, p);
    return p;
}

async function _appJson(appId, apiPath) {
    const base = frames.APP_INTERNAL_URLS[appId];
    if (!base) return null;
    try {
        const res = await fetch(`${String(base).replace(/\/+$/, '')}${apiPath}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn('[DevData] app fetch failed:', apiPath, err.message);
        return null;
    }
}

/** Resolve @username → app user id (live list first, channel lookup as fallback). */
async function _resolveUser(appId, name) {
    const lower = String(name).toLowerCase();
    const streams = await frames.appLiveStreams(appId);
    const live = streams.find(s => String(s.username || '').toLowerCase() === lower);
    if (live && live.user_id) return { uid: live.user_id, username: live.username };
    const ch = await _appJson(appId, `/api/streams/channel/${encodeURIComponent(name)}`);
    const uid = ch?.channel?.user_id ?? ch?.user?.id ?? null;
    if (uid) return { uid, username: ch?.user?.username || name };
    return null;
}

function _vodEntry(v, { withTranscript = true } = {}) {
    const out = {
        vod_id: v.id,
        title: v.title || null,
        created_at: v.created_at,
        duration_seconds: v.duration_seconds || 0,
        visibility: v.visibility || 'public',
        is_recording: !!v.is_recording,
        managed_stream_id: v.managed_stream_id || null,
        ai_overview: v.ai_overview || null,
        ai_analyzed_at: v.ai_analyzed_at || null,
    };
    if (withTranscript) out.transcript = v.ai_transcript || null;
    return out;
}

const VOD_COLS = 'id, title, created_at, duration_seconds, visibility, is_recording, managed_stream_id, user_id, ai_overview, ai_transcript, ai_analyzed_at';

/** Streamer-level extras from the app: chat insight + streamer overview + memories. */
async function _streamerExtras(appId, uid) {
    if (!uid) return null;
    const data = await _appJson(appId, `/api/chat-ai/user/${uid}`);
    if (!data) return null;
    return { user: data.user || null, streamer: data.streamer || null, chat_insight: data.insight || null };
}

/**
 * Transcript + AI overview timeline for a slot or streamer.
 * sel: slot id / slot slug → slot-scoped; @username → user-scoped (works offline).
 */
function getTranscriptTimeline(appId, sel, limit) {
    const n = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    return cached(`tt:${appId}:${sel}:${n}`, async () => {
        let rows = [], scope, label, uid = null;
        if (String(sel).startsWith('@')) {
            const user = await _resolveUser(appId, String(sel).slice(1));
            if (!user) return { status: 404, body: { error: `Streamer ${sel} not found` } };
            uid = user.uid; scope = 'streamer'; label = `@${user.username}`;
            rows = db.all(
                `SELECT ${VOD_COLS} FROM vods WHERE app_id = ? AND user_id = ? AND is_public = 1 AND COALESCE(clips_only,0) = 0
                 ORDER BY COALESCE(is_recording,0) DESC, created_at DESC LIMIT ?`, [appId, uid, n]);
        } else {
            const resolved = await frames.resolveSelector(appId, sel);
            if (!resolved.msid) return { status: 404, body: { error: `Slot '${sel}' not found or not live (slugs resolve while live; slot ids always work)` } };
            scope = 'slot'; label = resolved.label;
            rows = db.all(
                `SELECT ${VOD_COLS} FROM vods WHERE app_id = ? AND managed_stream_id = ? AND is_public = 1 AND COALESCE(clips_only,0) = 0
                 ORDER BY COALESCE(is_recording,0) DESC, created_at DESC LIMIT ?`, [appId, resolved.msid, n]);
            uid = rows[0]?.user_id ?? null;
        }
        const current = rows.find(v => v.is_recording) || null;
        const sessions = rows.filter(v => !v.is_recording);
        const extras = await _streamerExtras(appId, uid);
        return {
            status: 200,
            body: {
                scope, selector: String(sel), label,
                live: !!current,
                current: current ? _vodEntry(current) : null,
                sessions: sessions.map(v => _vodEntry(v)),
                streamer: extras?.streamer || null,          // overview + stream memories timeline
                user: extras?.user || null,
                generated_at: new Date().toISOString(),
            },
        };
    });
}

/** Transcript + AI overview for one existing VOD id. */
function getVodTranscript(vodId) {
    return cached(`vt:${vodId}`, async () => {
        const v = db.get(`SELECT ${VOD_COLS}, app_id, is_public FROM vods WHERE id = ?`, [vodId]);
        if (!v || v.visibility === 'private') return { status: 404, body: { error: 'VOD not found' } };
        return { status: 200, body: { ..._vodEntry(v), app_id: v.app_id, generated_at: new Date().toISOString() } };
    });
}

/** A user's chat-related AI insight/timeline. sel: @username or numeric app user id. */
function getChatInsight(appId, sel) {
    return cached(`ci:${appId}:${sel}`, async () => {
        let uid = null, username = null;
        if (/^\d+$/.test(String(sel))) uid = parseInt(sel, 10);
        else if (String(sel).startsWith('@')) {
            const user = await _resolveUser(appId, String(sel).slice(1));
            if (!user) return { status: 404, body: { error: `User ${sel} not found` } };
            uid = user.uid; username = user.username;
        } else return { status: 400, body: { error: 'Selector must be @username or a numeric user id' } };
        const data = await _appJson(appId, `/api/chat-ai/user/${uid}`);
        if (!data || (!data.insight && !data.streamer && !data.user)) {
            return { status: 404, body: { error: `No chat insight for ${username ? '@' + username : 'user ' + uid}` } };
        }
        return {
            status: 200,
            body: {
                user: data.user || (username ? { id: uid, username } : { id: uid }),
                chat_insight: data.insight || null,          // today-vs-alltime overviews + timeline + memory
                streamer: data.streamer || null,             // streamer overview + stream memories (when they stream)
                generated_at: new Date().toISOString(),
            },
        };
    });
}

module.exports = { getTranscriptTimeline, getVodTranscript, getChatInsight, CACHE_TTL_MS };
