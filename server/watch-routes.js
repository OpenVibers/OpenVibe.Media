/**
 * OpenVibe.Media — the watch-id API (plan track U, 2026-11-07).
 *
 *   GET /api/v1/:app/watch/:watch_id  → { kind: 'vod' | 'clip', id: <numeric id> }   (404 when no row holds it)
 *
 * An app that has a watch id — from a link, a share sheet, a stored canonical URL — asks Media which item it is. The
 * answer carries the kind and the numeric id only: the caller then reads the item through its own scoped read
 * (GET /vods/:id, GET /clips/:id), so a watch id belonging to another tenant resolves to an id that caller's read
 * answers 404 for, exactly as it did before the watch ids existed. Media's own visibility rules are unchanged.
 *
 * Ids are minted by this service (server/watch-ids.js) and are one space across VODs and clips, so a watch id has
 * exactly one answer.
 */
'use strict';

const express = require('express');
const { tenantAuth } = require('./auth');
const watchIds = require('./watch-ids');

const router = express.Router({ mergeParams: true });

router.get('/:watchId', tenantAuth({ verb: 'read', allowUser: true }), async (req, res) => {
    try {
        const ref = await watchIds.resolve(String(req.params.watchId || ''));
        if (!ref) return res.status(404).json({ error: 'Not found', code: 'media.watch.not_found' });
        res.set('Cache-Control', 'private, max-age=0');
        res.json(ref);
    } catch (err) {
        console.error('[Watch] resolve error:', err.message);
        res.status(500).json({ error: 'Failed to resolve the watch id' });
    }
});

module.exports = router;
