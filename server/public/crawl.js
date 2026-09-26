/**
 * OpenVibe.Media — crawler files at the origin: /robots.txt, /sitemap.xml, /llms.txt.
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
const pages = require('./pages');
const readiness = require('../objects/readiness');

const MAX_URLS = 45000;          // under the 50,000-URL sitemap limit
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

function sandboxApps() {
    return new Set(db.all("SELECT app_id FROM apps WHERE env = 'sandbox'").map(r => r.app_id));
}

/** The indexable watch pages, newest first: [{ loc, lastmod, images }]. */
function sitemapEntries() {
    const sandbox = sandboxApps();
    const out = [];
    const vods = db.all(`SELECT id, app_id, visibility, is_public, thumbnail_url, created_at FROM vods
        WHERE ${WATCH_WHERE.vod} ORDER BY created_at DESC LIMIT ?`, [MAX_URLS]);
    for (const v of vods) {
        if (sandbox.has(v.app_id) || !pages.watchIndexable('vod', v)) continue;
        out.push({ loc: `${config.publicUrl}/v/${v.id}`, lastmod: iso(v.created_at), images: v.thumbnail_url ? [abs(v.thumbnail_url)] : [] });
    }
    const clips = db.all(`SELECT id, app_id, visibility, is_public, auto_generated, thumbnail_url, created_at FROM clips
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
        summary: 'The media service of the OpenVibe network: it stores and serves recorded live streams (VODs), clips, thumbnails, screenshots and files for the network\'s apps.',
        details: [
            'Most media here belongs to OpenVibe.Live, whose /vod/:id and /clip/:id pages are the canonical pages for it (chat, transcript, the streamer\'s channel); the watch pages here point there.',
            'Clips marked "AI clip" were picked and cut automatically from a stream, not made by a person.',
            'Private and unlisted media is never listed here or in the sitemap.',
        ].join(' '),
        sections: [
            { title: 'Browse', links: [
                { title: 'Media index', url: `${base}/`, note: 'every public video, clip, image and file, newest first, each linking to its source page' },
                { title: 'Sitemap', url: `${base}/sitemap.xml`, note: 'the watch pages Media is the canonical home of' },
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

function send(res, type, body) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(type).send(body);
}

router.get('/robots.txt', (req, res) => send(res, 'text/plain', robotsTxt()));
router.get('/llms.txt', (req, res) => send(res, 'text/plain', llmsTxt()));
router.get('/sitemap.xml', (req, res) => {
    try {
        send(res, 'application/xml', seo.sitemapXml([{ loc: `${config.publicUrl}/`, changefreq: 'hourly' }, ...sitemapEntries()]));
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
