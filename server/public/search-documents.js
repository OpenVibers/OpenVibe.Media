'use strict';
/**
 * Media's own watch pages in OpenVibe.Search (roadmap WS-O task 10; Contracts 0.45.0
 * media.index_document.upserted|deleted): one document per VOD or clip whose canonical page is here
 * (/v/<id>, /c/<id>): exactly the pages the sitemap lists (./crawl.js WATCH_WHERE, pages.watchIndexable,
 * no sandbox tenant). Live's VODs and clips are not among them: their canonical pages are Live's, and
 * Live sends their documents (live.index_document type vod and clip).
 *
 *   sync()  every 10 minutes: every such page, sent when it changed, and a tombstone for each page sent
 *           before that no longer qualifies (deleted, private, unplayable, quarantined)
 *
 * search_doc_pushes keeps a hash and the revision, which grows by one with every document or tombstone;
 * the event is queued in the transaction that records the push. Off while the outbox is off.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db/database');
const events = require('../events');
const crawl = require('./crawl');
const pages = require('./pages');

const SYNC_MS = 10 * 60 * 1000;
const stats = { sent: 0, tombstones: 0, unchanged: 0, lastError: null, lastSyncAt: null };
let timer = null;


const iso = (v) => {
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(v)) ? `${String(v).replace(' ', 'T')}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32);

function documentFor(kind, row) {
    const doc = {
        owner: 'media', type: kind, id: String(row.id), deleted: false, visibility: 'public',
        canonical_url: `${config.publicUrl}/${kind === 'vod' ? 'v' : 'c'}/${row.id}`,
        title: clean(row.title, 500) || (kind === 'vod' ? 'Video' : 'Clip'),
        summary: clean(row.description, 4000) || `A ${kind === 'vod' ? 'video' : 'clip'} on OpenVibe.Media.`,
        facets: { app: String(row.app_id).slice(0, 200), duration_seconds: Math.round(Number(row.duration_seconds) || 0) },
        authorship: 'human', publication_state: 'published', published_at: iso(row.created_at),
        indexability: { decision: 'index' },
    };
    const body = clean(row.description, 40000);
    if (body) doc.body = body;
    return doc;
}

/** Send one document or tombstone when it changed. → 'sent' | 'tombstone' | 'unchanged' */
async function send(kind, id, doc, now) {
    const d = db.getDb();
    const prev = await d.prepare('SELECT hash, revision, deleted FROM search_doc_pushes WHERE kind = ? AND media_id = ?').get(kind, id);
    if (!doc && (!prev || prev.deleted)) { stats.unchanged++; return 'unchanged'; }
    const hash = doc ? hashOf(doc) : 'deleted';
    if (prev && prev.hash === hash) { stats.unchanged++; return 'unchanged'; }
    const revision = (prev ? prev.revision : 0) + 1;
    const sid = String(id);
    await d.tx(async () => {
        if (doc) await events.recordIndexDocument('media.index_document.upserted', { type: kind, id: sid, revision }, { ...doc, revision, updated_at: new Date(now).toISOString() });
        else await events.recordIndexDocument('media.index_document.deleted', { type: kind, id: sid, revision }, { type: kind, id: sid, revision });
        await d.prepare(`INSERT INTO search_doc_pushes (kind, media_id, hash, revision, deleted, pushed_at) VALUES (?, ?, ?, ?, ?, ov_now())
                   ON CONFLICT(kind, media_id) DO UPDATE SET hash = excluded.hash, revision = excluded.revision, deleted = excluded.deleted, pushed_at = excluded.pushed_at`)
            .run(kind, id, hash, revision, doc ? 0 : 1);
    });
    if (doc) { stats.sent++; return 'sent'; }
    stats.tombstones++;
    return 'tombstone';
}

async function sync({ now = Date.now() } = {}) {
    if (!(await events.status()).enabled) return 0;
    const sandbox = await crawl.sandboxApps();
    let n = 0;
    for (const kind of ['vod', 'clip']) {
        const table = kind === 'vod' ? 'vods' : 'clips';
        const rows = (await db.all(`SELECT id, app_id, title, description, duration_seconds, visibility, is_public, ${kind === 'clip' ? 'auto_generated, ' : ''}created_at
            FROM ${table} WHERE ${crawl.WATCH_WHERE[kind]}`)).filter((r) => !sandbox.has(r.app_id) && pages.watchIndexable(kind, r));
        const seen = new Set();
        for (const r of rows) {
            seen.add(r.id);
            try { await send(kind, r.id, documentFor(kind, r), now); n++; } catch (err) { stats.lastError = err.message; }
        }
        for (const p of await db.all('SELECT media_id FROM search_doc_pushes WHERE kind = ? AND deleted = 0', [kind])) {
            if (!seen.has(p.media_id)) { try { await send(kind, p.media_id, null, now); } catch (err) { stats.lastError = err.message; } }
        }
    }
    stats.lastSyncAt = new Date(now).toISOString();
    return n;
}

async function start() {
    if (timer || !(await events.status()).enabled || process.env.MEDIA_SEARCH_DOCUMENTS === 'off') return false;
    const run = async () => { try { await sync(); } catch (err) { stats.lastError = err.message; } };
    const first = setTimeout(run, 60 * 1000);
    if (first.unref) first.unref();
    timer = setInterval(run, SYNC_MS);
    if (timer.unref) timer.unref();
    return true;
}

function stop() { if (timer) clearInterval(timer); timer = null; }
function status() { return { ...stats }; }

module.exports = { start, stop, sync, documentFor, status };
