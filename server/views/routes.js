/**
 * OpenVibe.Media — app-facing view API (mounted at /api/v1/:app/views, app key).
 *
 *   POST /            { type: 'vod'|'clip'|'paste'|'file', id, ip?, user_id?, user_agent? }
 *                     Apps that render their own watch/paste pages call this when the page
 *                     opens. The real client IP travels in X-Forwarded-For (Live's proxy sets
 *                     it) or `ip`; the viewer's user id in X-OV-User-Id or `user_id`.
 *                     → { counted, unique, reason?, view_count, unique_views }
 *   GET  /?type=vod&ids=1,2,3   → { counts: { "1": {view_count, unique_views}, ... } }
 */
'use strict';
const express = require('express');
const db = require('../db/database');
const { tenantAuth } = require('../auth');
const views = require('./service');

const router = express.Router({ mergeParams: true });

function ownerOf(type, id) {
    const t = views.TABLES[type]; if (!t) return null;
    try { const r = db.get(`SELECT user_id FROM ${t.table} WHERE id = ?`, [id]); return r ? r.user_id : null; } catch { return null; }
}

router.post('/', tenantAuth(), (req, res) => {
    const body = req.body || {};
    const type = String(body.type || '');
    const id = parseInt(body.id, 10);
    if (!views.TABLES[type] || !id) return res.status(400).json({ error: 'type (vod|clip|paste|file) and id required' });
    // Deletion/tenancy guard: only the owning app may count views on its content.
    const t = views.TABLES[type];
    const row = db.get(`SELECT app_id, user_id FROM ${t.table} WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.app_id && row.app_id !== req.appId) return res.status(403).json({ error: 'Not your content' });
    const userId = body.user_id != null ? body.user_id : (req.userId != null ? req.userId : null);
    const out = views.recordView(type, id, { req, ip: body.ip || undefined, userId, ownerUserId: row.user_id, userAgent: body.user_agent || undefined });
    res.json(out);
});

router.get('/', tenantAuth({ allowUser: true }), (req, res) => {
    const type = String(req.query.type || '');
    if (!views.TABLES[type]) return res.status(400).json({ error: 'type required' });
    const ids = String(req.query.ids || '').split(',').map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
    res.json({ type, counts: views.countsMany(type, ids) });
});

module.exports = router;
