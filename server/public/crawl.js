/**
 * OpenVibe.Media — crawler files at the origin: /robots.txt, /sitemap.xml, /llms.txt, /llms-full.txt.
 *
 * The sitemap lists the pages search engines may index here: the media index (/) and the watch
 * pages of public, ready VODs and clips that Media is the canonical home of (pages.watchIndexable:
 * not Live's, which Live lists under its own /vod and /clip pages; never AI clips; never private or
 * unlisted; never a developer project's sandbox), and only while they are playable (their object is
 * ready and has a copy whose bytes were verified: server/objects/readiness.js). A URL here always
 * renders `index, follow` with a player.
 */
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db/database');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const pages = require('./pages');
const readiness = require('../objects/readiness');

const MAX_URLS = 45000;          // under the 50,000-URL sitemap limit
const LLMS_FULL_MAX_BYTES = 512 * 1024;   // cap an /llms-full.txt over every watch page
const MAX_FULL_PAGES = 2000;     // rows considered for the full-text file (rendering every page at once is unbounded)
const LLMS_SUMMARY = 'The media service of the OpenVibe network: it stores and serves recorded live streams (VODs), clips, thumbnails, screenshots and files for the network\'s apps.';
const router = express.Router();

const iso = (v) => {
    if (!v) return null;
    const s = String(v);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const abs = (u) => (!u ? null : (/^https?:\/\//i.test(u) ? u : `${config.publicUrl}${u.startsWith('/') ? '' : '/'}${u}`));

/**
 * The watch pages Media is the canonical home of, as SQL: public, finished, playable, made by a person,
 * owned by an app other than Live. The sitemap and the Search documents (./search-documents.js) both
 * use it; pages.watchIndexable and the sandbox check still apply to each row.
 */
const WATCH_WHERE = {
    vod: `COALESCE(is_recording, 0) = 0 AND COALESCE(clips_only, 0) = 0 AND is_public = 1 AND COALESCE(visibility, 'public') = 'public'
          AND quarantined_at IS NULL AND COALESCE(health_status, 'ok') NOT IN ('corrupt', 'zero_byte', 'missing_file', 'needs_review')
          AND file_path IS NOT NULL AND app_id != 'live' AND ${readiness.playableSql('vods.object_id')}`,
    clip: `COALESCE(status, 'ready') = 'ready' AND COALESCE(is_public, 1) = 1 AND COALESCE(visibility, 'public') = 'public'
          AND COALESCE(auto_generated, 0) = 0 AND COALESCE(file_path, '') != '' AND app_id != 'live' AND ${readiness.playableSql('clips.object_id')}`,
};

async function sandboxApps() {
    return new Set((await db.all("SELECT app_id FROM apps WHERE env = 'sandbox'")).map(r => r.app_id));
}

/** The indexable watch pages, newest first: [{ loc, lastmod, images }]. */
async function sitemapEntries() {
    const sandbox = await sandboxApps();
    const out = [];
    const vods = await db.all(`SELECT id, app_id, visibility, is_public, thumbnail_url, created_at FROM vods
        WHERE ${WATCH_WHERE.vod} ORDER BY created_at DESC LIMIT ?`, [MAX_URLS]);
    for (const v of vods) {
        if (sandbox.has(v.app_id) || !pages.watchIndexable('vod', v)) continue;
        out.push({ loc: `${config.publicUrl}/v/${v.id}`, lastmod: iso(v.created_at), images: v.thumbnail_url ? [abs(v.thumbnail_url)] : [] });
    }
    const clips = await db.all(`SELECT id, app_id, visibility, is_public, auto_generated, thumbnail_url, created_at FROM clips
        WHERE ${WATCH_WHERE.clip} ORDER BY created_at DESC LIMIT ?`, [MAX_URLS]);
    for (const c of clips) {
        if (sandbox.has(c.app_id) || !pages.watchIndexable('clip', c)) continue;
        out.push({ loc: `${config.publicUrl}/c/${c.id}`, lastmod: iso(c.created_at), images: c.thumbnail_url ? [abs(c.thumbnail_url)] : [] });
    }
    out.sort((a, b) => String(b.lastmod || '').localeCompare(String(a.lastmod || '')));
    return out.slice(0, MAX_URLS - 1);
}

function robotsTxt() {
    return seo.robotsTxt({
        sitemaps: [`${config.publicUrl}/sitemap.xml`],
        // APIs, sign-in, signed object bytes, operator and dev-data endpoints are not pages; /me is a
        // signed-in person's own media (noindex as well).
        disallow: ['/api/', '/auth/', '/internal/', '/o/', '/metrics', '/release-metrics', '/live/', '/me'],
    });
}

function llmsTxt() {
    const base = config.publicUrl;
    return seo.llmsTxt({
        name: 'OpenVibe.Media',
        summary: LLMS_SUMMARY,
        details: [
            'Most media here belongs to OpenVibe.Live, whose /vod/:id and /clip/:id pages are the canonical pages for it (chat, transcript, the streamer\'s channel); the watch pages here point there.',
            'Clips marked "AI clip" were picked and cut automatically from a stream, not made by a person.',
            'Private and unlisted media is never listed here or in the sitemap.',
        ].join(' '),
        sections: [
            { title: 'Browse', links: [
                { title: 'Media index', url: `${base}/`, note: 'every public video, clip, image and file, newest first, each linking to its source page' },
                { title: 'Sitemap', url: `${base}/sitemap.xml`, note: 'the watch pages Media is the canonical home of' },
                { title: 'Full text', url: `${base}/llms-full.txt`, note: 'those same pages with their full text, for language models' },
            ] },
            { title: 'URLs', links: [
                { title: 'VOD watch page', url: `${base}/v/{id}`, note: 'a page for browsers; ?raw=1 returns the video bytes' },
                { title: 'Clip watch page', url: `${base}/c/{id}`, note: 'as above, for clips' },
                { title: 'VOD transcript', url: `${base}/v/{id}/transcript.json`, note: 'transcript and AI overview of a public VOD (JSON)' },
            ] },
            { title: 'The network', links: [
                { title: 'OpenVibe.Live', url: 'https://openvibe.live/', note: 'live streams, channels, VOD and clip pages' },
                { title: 'OpenVibe.Community', url: 'https://openvibe.community/', note: 'pastes and discussion' },
                { title: 'OpenVibe.Network', url: 'https://openvibe.network/', note: 'accounts and the network directory' },
            ] },
        ],
    });
}

/**
 * The indexable watch pages with the fields a watch page renders, newest first: the same set the
 * sitemap lists (WATCH_WHERE, pages.watchIndexable, no sandbox tenant). Used by /llms-full.txt,
 * which bounds how many it will render (`limit`).
 */
async function indexableWatchRows(limit = MAX_URLS) {
    const sandbox = await sandboxApps();
    const out = [];
    const base = 'id, app_id, visibility, is_public, title, description, ai_overview, thumbnail_url, file_path, duration_seconds, view_count, created_at';
    for (const kind of ['vod', 'clip']) {
        const table = kind === 'vod' ? 'vods' : 'clips';
        // vods has no auto_generated column (only clips do); pages.watchIndexable reads it for clips.
        const cols = kind === 'clip' ? `${base}, auto_generated` : base;
        const rows = await db.all(`SELECT ${cols} FROM ${table} WHERE ${WATCH_WHERE[kind]} ORDER BY created_at DESC LIMIT ?`, [limit]);
        for (const row of rows) {
            if (sandbox.has(row.app_id) || !pages.watchIndexable(kind, row)) continue;
            out.push({ kind, row });
        }
    }
    out.sort((a, b) => String(b.row.created_at || '').localeCompare(String(a.row.created_at || '')));
    return out.slice(0, limit);
}

/**
 * /llms-full.txt (openvibe-shared/seo.llmsFull): the /llms.txt header, then the full text of the
 * public media pages — the index and the newest watch pages Media is the canonical home of, rendered
 * by the same pages.renderWatchPage the browser gets and stripped to text. Pages are rendered only
 * until the byte cap is passed, so a large estate cannot make the request unbounded; any that remain
 * become the standard "(truncated: N more pages …)" line.
 */
async function llmsFullTxt() {
    const base = config.publicUrl;
    const rows = await indexableWatchRows(MAX_FULL_PAGES);
    const watchPages = [];
    let bytes = 0;
    for (const { kind, row } of rows) {
        const html = pages.renderWatchPage(kind, row);
        watchPages.push({
            title: String(row.title || (kind === 'vod' ? `VOD #${row.id}` : `Clip #${row.id}`)),
            url: `${base}/${kind === 'vod' ? 'v' : 'c'}/${row.id}`,
            html,
        });
        bytes += Buffer.byteLength(html);
        if (bytes > LLMS_FULL_MAX_BYTES) break;   // the cap is already passed; stop rendering the rest
    }
    return seo.llmsFull({
        site: { name: 'OpenVibe.Media', url: base },
        summary: LLMS_SUMMARY,
        base,
        maxBytes: LLMS_FULL_MAX_BYTES,
        sections: [
            { title: 'Browse', pages: [{ title: 'Media index', url: `${base}/`, text: 'Every public video, clip, image and file on OpenVibe.Media, newest first, each linking to its source page in the app that made it.' }] },
            { title: 'Watch pages', pages: watchPages },
        ],
    });
}

function send(res, type, body) {
    res.set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }));
    res.type(type).send(body);
}

router.get('/robots.txt', (req, res) => send(res, 'text/plain', robotsTxt()));
router.get('/llms.txt', (req, res) => send(res, 'text/plain', llmsTxt()));
router.get('/llms-full.txt', async (req, res) => {
    try {
        send(res, 'text/plain', await llmsFullTxt());
    } catch (err) {
        console.error('[Public] llms-full error:', err.message);
        res.status(500).type('text/plain').send('llms-full unavailable');
    }
});
router.get('/sitemap.xml', async (req, res) => {
    try {
        send(res, 'application/xml', seo.sitemapXml([{ loc: `${config.publicUrl}/`, changefreq: 'hourly' }, ...await sitemapEntries()]));
    } catch (err) {
        console.error('[Public] sitemap error:', err.message);
        res.status(500).type('text/plain').send('sitemap unavailable');
    }
});

module.exports = router;
module.exports.sitemapEntries = sitemapEntries;
module.exports.WATCH_WHERE = WATCH_WHERE;
module.exports.sandboxApps = sandboxApps;
module.exports.robotsTxt = robotsTxt;
module.exports.llmsTxt = llmsTxt;
module.exports.llmsFullTxt = llmsFullTxt;
module.exports.indexableWatchRows = indexableWatchRows;
