'use strict';
/**
 * OpenVibe.Media — owner-subject reconcile job (docs/object-model.md#owner-subjects).
 *
 * Every MEDIA_OWNER_SUBJECT_INTERVAL_MIN minutes (first run a minute after boot), objects that name
 * an app-local owner (owner_app + owner_user_id) and no owner_subject get their owner's canonical
 * subject from Network (server/objects/owner-subject.js). This is how objects created since the
 * backfill get one: the upload and projection paths never wait on Network, and an object whose owner
 * Network does not know yet (a Live account not linked to Network) is filled on a later run once it is.
 * When there is nothing to fill, a run asks Network nothing.
 *
 * MEDIA_OWNER_SUBJECT_SYNC=0 turns it off (do that before rolling a backfill back, or the next run
 * fills the rows again).
 */
const db = require('../db/database');
const config = require('../config');
const ownerSubject = require('./owner-subject');

let _timer = null, _startTimer = null, _busy = false, _resolver = null;
const stats = { runs: 0, filled_total: 0, last_run_at: null, last: null, last_error: null };

async function runOnce({ resolver } = {}) {
    if (_busy) return null;
    _busy = true;
    try {
        if (!resolver) resolver = _resolver || (_resolver = ownerSubject.createResolver());
        const r = await ownerSubject.reconcileOnce(db.getDb(), { resolver });
        stats.runs++;
        stats.filled_total += r.filled;
        stats.last_run_at = new Date().toISOString();
        stats.last = r;
        stats.last_error = null;
        if (r.filled) console.log(`[OwnerSubject] filled owner_subject on ${r.filled} object(s) (${r.unresolvable} still unresolvable, via ${r.via})`);
        return r;
    } catch (err) {
        if (err.message !== stats.last_error) console.warn('[OwnerSubject] run failed (next run retries):', err.message);
        stats.last_error = err.message;
        return null;
    } finally {
        _busy = false;
    }
}

function start({ initialDelayMs = 60 * 1000 } = {}) {
    if (!config.ownerSubject.enabled) { console.log('[OwnerSubject] reconcile job disabled (MEDIA_OWNER_SUBJECT_SYNC=0)'); return false; }
    if (_timer || _startTimer) return true;
    const tick = () => { runOnce().catch(() => {}); };
    _startTimer = setTimeout(() => {
        _startTimer = null;
        tick();
        _timer = setInterval(tick, Math.max(1, config.ownerSubject.intervalMin) * 60 * 1000);
        if (_timer.unref) _timer.unref();
    }, initialDelayMs);
    if (_startTimer.unref) _startTimer.unref();
    return true;
}

function stop() {
    if (_startTimer) { clearTimeout(_startTimer); _startTimer = null; }
    if (_timer) { clearInterval(_timer); _timer = null; }
}

function status() { return { ...stats, running: !!(_timer || _startTimer) }; }

module.exports = { runOnce, start, stop, status };
