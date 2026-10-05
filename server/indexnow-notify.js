/**
 * OpenVibe.Media — tell search engines when a watch page becomes indexable.
 *
 * server/index.js creates the IndexNow client once at boot (openvibe-shared/indexnow) and hands it
 * here with use(). The transitions that can make /v/:id or /c/:id indexable — a VOD finalizing, a
 * clip becoming ready, and a visibility change on either — call pingWatch() with the row they just
 * wrote; it queues the page and the sitemap for one batched POST.
 *
 * Only a page that is actually indexable is pinged (pages.watchIndexable: public, not Live's, not an
 * AI clip) and never one belonging to a developer sandbox tenant, so private, unlisted and sandbox
 * media is never announced to an engine. A restore drill pings nothing (server/drill.js). Nothing
 * here is called at module load, and a ping never throws into its caller.
 */
'use strict';

const config = require('./config');
const db = require('./db/database');
const pages = require('./public/pages');
const drill = require('./drill');

let client = null;

/** Install the client booted in server/index.js. A missing/disabled client means pinging is off. */
function use(indexnow) {
    client = indexnow && indexnow.enabled ? indexnow : null;
}

/**
 * Queue an IndexNow ping for a VOD/clip row that just became ready or public: the watch page and the
 * sitemap. Returns true when URLs were queued. Never throws (a failed ping must not fail a publish).
 */
async function pingWatch(kind, row) {
    try {
        if (drill.enabled || !client || !row || !pages.watchIndexable(kind, row)) return false;
        if (await db.isSandboxTenant(row.app_id)) return false;
        const self = `${config.publicUrl}/${kind === 'vod' ? 'v' : 'c'}/${row.id}`;
        return client.pingSoon([self, `${config.publicUrl}/sitemap.xml`]) > 0;
    } catch (err) {
        console.warn('[IndexNow] notify failed:', err.message);
        return false;
    }
}

module.exports = { use, pingWatch };
