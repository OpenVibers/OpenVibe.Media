/**
 * OpenVibe.Media — the audio-description track for a watch page (X1, consent plan 2026-10-31, "AI and data").
 *
 * Live owns the scene notes and the speech timeline, and serves the WebVTT at
 * /api/vods/:id/descriptions.vtt and /api/clips/:id/descriptions.vtt. This module puts the track on the same
 * origin as the page (`/v/:id/descriptions.vtt`) so the shared player can load it without cross-origin track
 * rules, and so Media applies its own visibility rule before asking:
 *
 *   public / unlisted  anyone may read it (the page and its track are cacheable);
 *   private            only when the viewer proves who they are: the owning app's key, a signed playback URL,
 *                      or the site's own Network session cookie, which is forwarded to Live, the one service
 *                      that can check that this person owns the item. Nothing private is cached.
 *
 * Only Live's media is described: other apps have no scene-note timeline behind them. A missing item, another
 * app's item, a private item the caller cannot prove, Live being down, or no notes to describe all answer the
 * same 404 as a missing media id.
 */
'use strict';

const db = require('../db/database');
const frames = require('../thumbnails/live-frame-service');

const CACHE_TTL_MS = 60_000;
const _cache = new Map();      // "vod:100" → { at, vtt }
const _inFlight = new Map();

function notFound(res) {
    return res.status(404).json({ error: 'Not found' });
}

function recordVisibility(record) {
    return record.visibility || (record.is_public ? 'public' : 'private');
}

/** A private item's caller: the owning app, a signed playback URL, or this site's Network session (checked by Live). */
function mayAskPrivate(record, req, kind) {
    if (req.authType === 'app' && req.appId === record.app_id) return true;
    if (req.authType === 'user' && req.userId != null && record.user_id === req.userId) return true;
    if (req.query && req.query.exp && req.query.sig && require('../objects/signing').verifyMedia(kind, record.id, req.query.exp, String(req.query.sig))) return true;
    const token = req.cookies && req.cookies.ov_token;
    return typeof token === 'string' && token.length > 0 && token.length < 4096;
}

async function fromLive(kind, id, req) {
    const base = frames.APP_INTERNAL_URLS.live;
    if (!base) return null;
    const path = `${String(base).replace(/\/+$/, '')}/api/${kind === 'clip' ? 'clips' : 'vods'}/${encodeURIComponent(id)}/descriptions.vtt`;
    const headers = {};
    const token = req.cookies && req.cookies.ov_token;
    if (typeof token === 'string' && token.length > 0 && token.length < 4096) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch(path, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const vtt = await res.text();
        return /^WEBVTT\r?\n/.test(vtt) ? vtt : null;
    } catch (err) {
        console.warn('[Descriptions] Live fetch failed:', err.message);
        return null;
    }
}

async function handle(kind, req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return notFound(res);
    const record = kind === 'clip' ? await db.getClipById(id) : await db.getVodById(id);
    if (!record) return notFound(res);
    const visibility = recordVisibility(record);
    const isPrivate = visibility === 'private';
    if (isPrivate && !mayAskPrivate(record, req, kind)) return notFound(res);
    if ((record.app_id || 'live') !== 'live') return notFound(res);

    const cacheKey = `${kind}:${id}`;
    const mayUseCache = !isPrivate && !(req.cookies && req.cookies.ov_token);
    if (mayUseCache) {
        const hit = _cache.get(cacheKey);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return send(res, hit.vtt, false);
        if (_inFlight.has(cacheKey)) {
            const vtt = await _inFlight.get(cacheKey);
            return vtt ? send(res, vtt, false) : notFound(res);
        }
    }
    const pending = fromLive(kind, id, req);
    if (mayUseCache) {
        _inFlight.set(cacheKey, pending);
        pending.finally(() => _inFlight.delete(cacheKey)).catch(() => {});
    }
    const vtt = await pending;
    if (!vtt) return notFound(res);
    if (mayUseCache) {
        if (_cache.size > 500) {
            const cutoff = Date.now() - CACHE_TTL_MS;
            for (const [k, v] of _cache) { if (v.at < cutoff) _cache.delete(k); }
        }
        _cache.set(cacheKey, { at: Date.now(), vtt });
    }
    return send(res, vtt, isPrivate);
}

function send(res, vtt, isPrivate) {
    res.set({
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': isPrivate ? 'private, no-store' : 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
    });
    return res.send(vtt);
}

module.exports = { handle, mayAskPrivate, CACHE_TTL_MS };
