'use strict';

/**
 * OpenVibe.Media — the public view API (mounted at /api/v1/views, before the tenant routes).
 *
 *   POST /api/v1/views  { events: [view, …] }  (or one view object)   up to 20
 *        view = { ref: { service, kind, id, site?, creator? }, how: preview|watch|live, seconds,
 *                 of_seconds?, session? }
 *        → { results: [{ accepted, counted, engaged, reason? }] }
 *   GET  /api/v1/views/counts?service=&kind=&id=       → { ref, counts }
 *        ?service=&kind=&ids=1,2,3                     → { counts: { "service:kind:id": counts } }
 *        ?refs=<JSON [{service,kind,id}]>              → the same, at most 50 refs
 *   GET  /api/v1/views/aggregate?scope=item|creator|site&id=&days=&service=&kind=
 *        → { scope, id, days, from, to, rows, totals } for Report
 *
 * This is a browser beacon: CORS * and no cookie, no IP or user agent stored. It answers 200 for an event it did not
 * count (a bot, a repeated view inside the window, a rate limit) and never says whether an item exists.
 */
const express = require('express');
const views = require('./unified');

const router = express.Router();

function cors(req, res) {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        Vary: 'Origin',
    });
}

router.use((req, res, next) => { cors(req, res); if (req.method === 'OPTIONS') return res.status(204).end(); return next(); });

router.post('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const list = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : body.ref ? [body] : null;
    if (!list || !list.length) return res.status(400).json({ error: 'Send { events: [ … ] } with at least one view', code: 'views.batch_size' });
    if (list.length > views.MAX_BATCH) return res.status(400).json({ error: `At most ${views.MAX_BATCH} views in one call`, code: 'views.batch_size' });
    const out = await views.record(list, { req });
    if (out.error) return res.status(400).json({ error: 'At most 20 views in one call', code: out.error });
    return res.json(out);
});

router.get('/counts', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=30');
    const refsParam = String(req.query.refs || '');
    if (refsParam) {
        let refs;
        try { refs = JSON.parse(refsParam); } catch { return res.status(400).json({ error: 'refs must be JSON', code: 'views.refs' }); }
        if (!Array.isArray(refs) || refs.length > 50) return res.status(400).json({ error: 'refs is an array of at most 50 refs', code: 'views.refs' });
        const valid = [];
        for (const raw of refs) { const r = views.normalizeRef(raw); if (r.ok) valid.push(r.ref); }
        return res.json({ counts: await views.countsMany(valid) });
    }
    const service = String(req.query.service || '');
    const kind = String(req.query.kind || '');
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (!service || !kind) return res.status(400).json({ error: 'service and kind are required', code: 'views.ref' });
    if (req.query.id != null || (!ids.length && req.query.id != null)) {
        const r = views.normalizeRef({ service, kind, id: req.query.id });
        if (!r.ok) return res.status(400).json({ error: 'a valid ref is required', code: r.error });
        return res.json({ ref: r.ref, counts: await views.countsFor(r.ref) });
    }
    if (!ids.length) return res.status(400).json({ error: 'id or ids is required', code: 'views.ref' });
    const refs = ids.map((id) => ({ service, kind, id })).filter((r) => views.normalizeRef(r).ok);
    return res.json({ counts: await views.countsMany(refs) });
});

router.get('/aggregate', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    const scope = String(req.query.scope || 'item');
    const out = await views.aggregate({
        scope,
        id: req.query.id != null ? String(req.query.id) : null,
        days: req.query.days,
        service: req.query.service != null ? String(req.query.service) : null,
        kind: req.query.kind != null ? String(req.query.kind) : null,
        limit: req.query.limit,
    });
    if (out.error) return res.status(400).json({ error: 'scope is item, creator or site', code: out.error });
    return res.json(out);
});

module.exports = router;
