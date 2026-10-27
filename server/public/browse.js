/**
 * OpenVibe.Media — public media index ("home page").
 *
 * Server-rendered browse UI at GET / — a mass index of every public piece of
 * media this service owns, tabbed by kind (Videos / Clips / Thumbnails / Files).
 * Each card carries its description / AI overview and a link to its source page
 * in the owning app. Composed by page-frame (the shared shell) with the showcase hero on
 * the first page; no client JS required.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

const PAGE_SIZE = 48;
const THUMB_DIR = path.resolve(config.thumbnails.path);

// Public base URL per app for "source" links — shared with the watch pages.
const pageFrame = require('./page-frame');
const { appUrl, watchPageUrl, isoDate } = pageFrame;
const cache = require('openvibe-shared/cache-policy');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (u) => (!u ? null : (/^https?:\/\//i.test(u) ? u : `${config.publicUrl}${u.startsWith('/') ? '' : '/'}${u}`));
const snip = (s, n = 180) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const fmtDur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60), r = s % 60; return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}:${String(r).padStart(2, '0')}`; };

// ── Row → card model per kind ────────────────────────────────
function vodCard(v) {
    return {
        kind: 'video', title: v.title || `VOD #${v.id}`, date: v.created_at, app: v.app_id,
        thumb: abs(v.thumbnail_url), duration: v.duration_seconds,
        text: snip(v.description || v.ai_overview),
        view: `${config.publicUrl}/v/${v.id}`,
        source: watchPageUrl('vod', v.app_id, v.id), sourceLabel: 'VOD page',
    };
}
function clipCard(c) {
    return {
        kind: 'clip', title: c.title || `Clip #${c.id}`, date: c.created_at, app: c.app_id,
        thumb: abs(c.thumbnail_url), duration: c.duration_seconds,
        text: snip(c.description || c.ai_overview),
        view: `${config.publicUrl}/c/${c.id}`,
        source: watchPageUrl('clip', c.app_id, c.id), sourceLabel: 'Clip page',
    };
}
function fileCard(f) {
    return {
        kind: 'file', title: f.original_name || f.key, date: f.created_at, app: f.app_id,
        thumb: (f.mime || '').startsWith('image/') ? `${config.publicUrl}/f/${encodeURIComponent(f.key)}` : null,
        text: snip(`${f.mime || 'file'}${f.size > 0 ? ` · ${Math.round(f.size / 1024)} KB` : ''}`),
        view: `${config.publicUrl}/f/${encodeURIComponent(f.key)}`,
        source: null,
    };
}
function assetCard(a) {
    const isEmote = a.kind === 'emote';
    const channel = a.channel_username || a.username || '';
    return {
        kind: a.kind, title: isEmote ? a.name : `!${a.name}`, date: a.created_at, app: a.app_id,
        thumb: isEmote ? `${config.publicUrl}/a/${a.id}` : null,
        duration: !isEmote ? a.duration_seconds : null,
        text: `uploaded by ${a.username || 'unknown'}${channel ? ` · channel @${channel}` : ''}`,
        view: `${config.publicUrl}/a/${a.id}`,
        source: channel ? `${appUrl(a.app_id)}/@${encodeURIComponent(channel)}` : null,
        sourceLabel: channel ? `@${channel}'s channel` : null,
    };
}

function thumbCard(name, mtimeMs) {
    const m = /^(vod|clip|stream)-(\d+)/.exec(name);
    let source = null, sourceLabel = null;
    if (m) {
        const base = appUrl('live');
        if (m[1] === 'vod') { source = watchPageUrl('vod', 'live', m[2]); sourceLabel = 'VOD page'; }
        else if (m[1] === 'clip') { source = watchPageUrl('clip', 'live', m[2]); sourceLabel = 'Clip page'; }
        else { source = `${base}/stream/${m[2]}`; sourceLabel = 'Stream'; }
    }
    return {
        kind: 'thumbnail', title: name, date: new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' '),
        thumb: `${config.publicUrl}/t/${encodeURIComponent(name)}`, text: '',
        view: `${config.publicUrl}/t/${encodeURIComponent(name)}`, source, sourceLabel,
    };
}

// ── Data per tab ─────────────────────────────────────────────
// A recording's later parts (docs/recordings.md) are not videos of their own here: its first part stands for it.
const V_WHERE = "is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0 AND NOT EXISTS (SELECT 1 FROM media_recording_parts rp WHERE rp.vod_id = vods.id AND rp.seq > 1)";
const C_WHERE = "COALESCE(is_public,1) = 1";
// Developer-project tenants' files (ADR-014) are theirs to share; the gallery lists first-party files only.
const F_WHERE = "app_id NOT IN (SELECT app_id FROM apps WHERE project_id IS NOT NULL)";

// A VOD's or clip's thumbnail is listed only while the recording itself is public. The exact file name
// is what /t/<name> serves, so listing a private or unlisted recording's thumbnail would publish a frame
// of it (and its id) to anyone reading the index.
const THUMB_PUBLIC = {
    vod: "is_public = 1 AND COALESCE(visibility, 'public') = 'public' AND COALESCE(clips_only, 0) = 0",
    clip: "COALESCE(is_public, 1) = 1 AND COALESCE(visibility, 'public') = 'public'",
};
function thumbListable(name, publicIds) {
    const m = /^(vod|clip)-(\d+)-/i.exec(name);
    return !m || publicIds[m[1].toLowerCase()].has(Number(m[2]));
}

let _thumbListCache = { at: 0, list: [] };
async function thumbList() {
    if (Date.now() - _thumbListCache.at < 60_000) return _thumbListCache.list;
    let list = [];
    try {
        const publicIds = {
            vod: new Set((await db.all(`SELECT id FROM vods WHERE ${THUMB_PUBLIC.vod}`)).map(r => r.id)),
            clip: new Set((await db.all(`SELECT id FROM clips WHERE ${THUMB_PUBLIC.clip}`)).map(r => r.id)),
        };
        list = fs.readdirSync(THUMB_DIR)
            .filter(f => /\.(jpe?g|png|webp)$/i.test(f) && thumbListable(f, publicIds))
            .map(f => { try { return [f, fs.statSync(path.join(THUMB_DIR, f)).mtimeMs]; } catch { return null; } })
            .filter(Boolean)
            .sort((a, b) => b[1] - a[1]);
    } catch { /* */ }
    _thumbListCache = { at: Date.now(), list };
    return list;
}

async function fetchTab(tab, page) {
    const off = (page - 1) * PAGE_SIZE;
    const L = `ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${off}`;
    switch (tab) {
        case 'videos': return {
            total: (await db.get(`SELECT COUNT(*) c FROM vods WHERE ${V_WHERE}`)).c,
            cards: (await db.all(`SELECT * FROM vods WHERE ${V_WHERE} ${L}`)).map(vodCard),
        };
        case 'clips': return {
            total: (await db.get(`SELECT COUNT(*) c FROM clips WHERE ${C_WHERE}`)).c,
            cards: (await db.all(`SELECT * FROM clips WHERE ${C_WHERE} ${L}`)).map(clipCard),
        };
        case 'files': return {
            total: (await db.get(`SELECT COUNT(*) c FROM files WHERE ${F_WHERE}`)).c,
            cards: (await db.all(`SELECT * FROM files WHERE ${F_WHERE} ${L}`)).map(fileCard),
        };
        case 'emotes': return {
            total: (await db.get("SELECT COUNT(*) c FROM assets WHERE kind = 'emote'")).c,
            cards: (await db.all(`SELECT * FROM assets WHERE kind = 'emote' ${L}`)).map(assetCard),
        };
        case 'sounds': return {
            total: (await db.get("SELECT COUNT(*) c FROM assets WHERE kind = 'sound'")).c,
            cards: (await db.all(`SELECT * FROM assets WHERE kind = 'sound' ${L}`)).map(assetCard),
        };
        case 'thumbnails': {
            const list = await thumbList();
            return { total: list.length, cards: list.slice(off, off + PAGE_SIZE).map(([f, t]) => thumbCard(f, t)) };
        }
        default: { // all — one unified reverse-chronological index across DB-backed media
            const rows = await db.all(`
                SELECT 'vod' k, id ref, title, description, ai_overview, thumbnail_url, duration_seconds, created_at, app_id, NULL slug, NULL type, NULL content, NULL language FROM vods WHERE ${V_WHERE}
                UNION ALL
                SELECT 'clip', id, title, description, ai_overview, thumbnail_url, duration_seconds, created_at, app_id, NULL, NULL, NULL, NULL FROM clips WHERE ${C_WHERE}
                UNION ALL
                SELECT 'asset', id, name, username, channel_username, kind, duration_seconds, created_at, app_id, NULL, NULL, NULL, NULL FROM assets
                ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${off}`);
            const total = (await db.get(`SELECT
                (SELECT COUNT(*) FROM vods WHERE ${V_WHERE}) +
                (SELECT COUNT(*) FROM clips WHERE ${C_WHERE}) +
                (SELECT COUNT(*) FROM assets) c`)).c;
            const cards = rows.map(r => r.k === 'vod' ? vodCard({ ...r, id: r.ref })
                : r.k === 'clip' ? clipCard({ ...r, id: r.ref })
                : assetCard({ id: r.ref, name: r.title, username: r.description, channel_username: r.ai_overview, kind: r.thumbnail_url, duration_seconds: r.duration_seconds, created_at: r.created_at, app_id: r.app_id }));
            return { total, cards };
        }
    }
}

let _countCache = { at: 0, counts: null };
async function tabCounts() {
    if (_countCache.counts && Date.now() - _countCache.at < 60_000) return _countCache.counts;
    const c = async (sql) => { try { return (await db.get(sql)).c; } catch { return 0; } };
    const counts = {
        videos: await c(`SELECT COUNT(*) c FROM vods WHERE ${V_WHERE}`),
        clips: await c(`SELECT COUNT(*) c FROM clips WHERE ${C_WHERE}`),
        files: await c(`SELECT COUNT(*) c FROM files WHERE ${F_WHERE}`),
        emotes: await c("SELECT COUNT(*) c FROM assets WHERE kind = 'emote'"),
        sounds: await c("SELECT COUNT(*) c FROM assets WHERE kind = 'sound'"),
        thumbnails: (await thumbList()).length,
    };
    counts.all = counts.videos + counts.clips + counts.emotes + counts.sounds;
    _countCache = { at: Date.now(), counts };
    return counts;
}

// ── Rendering ────────────────────────────────────────────────
const KIND_ICON = { video: '🎬', clip: '✂️', thumbnail: '🏞️', file: '📦' };

/** JSON-LD for the index's first page: the site, and the cards it lists (ItemList). Later pages are noindex. */
function browseJsonLd(tab, cards) {
    const seo = require('openvibe-shared/seo');
    const abs = (u) => { try { return new URL(u, `${config.publicUrl}/`).toString(); } catch { return null; } };
    const items = cards.map((c) => ({ name: c.title || 'Untitled', url: abs(c.view) })).filter((it) => it.url);
    return [
        tab === 'all' ? seo.jsonLd.website({ name: 'OpenVibe.Media', url: `${config.publicUrl}/`, description: 'Every public file on the OpenVibe network: videos, clips, files and thumbnails.' }) : null,
        items.length ? seo.jsonLd.itemList(tab === 'all' ? 'Latest public media' : `Latest public ${tab}`, items, { url: `${config.publicUrl}/${tab === 'all' ? '' : `?tab=${tab}`}` }) : null,
    ].filter(Boolean);
}

function renderCard(c) {
    const preview = c.thumb
        ? `<img src="${esc(c.thumb)}" alt="" loading="lazy">`
        : `<div class="ph">${KIND_ICON[c.kind] || '📦'}</div>`;
    return `<div class="card">
  <a class="thumb" href="${esc(c.view)}">${preview}
    ${c.duration ? `<span class="dur">${fmtDur(c.duration)}</span>` : ''}
    <span class="kind">${esc(c.kind)}</span></a>
  <div class="meta">
    <div class="title" title="${esc(c.title)}">${esc(c.title)}</div>
    ${c.text ? `<div class="desc">${esc(c.text)}</div>` : ''}
    <div class="foot">
      <span>${esc(String(c.date || '').slice(0, 16))}${c.lang ? ` · ${esc(c.lang)}` : ''}${c.app ? ` · ${esc(c.app)}` : ''}</span>
      <span class="links"><a href="${esc(c.view)}">view</a>${c.source ? ` · <a href="${esc(c.source)}" title="${esc(c.sourceLabel || 'source')}">source ↗</a>` : ''}</span>
    </div>
  </div>
</div>`;
}

const TABS = [['all', 'All'], ['videos', 'Videos'], ['clips', 'Clips'], ['emotes', 'Emotes'], ['sounds', 'Sounds'], ['thumbnails', 'Thumbnails'], ['files', 'Files']];

// The index's own rules; page-frame's baseCss supplies the palette (--panel, --line, --muted, --acc …) and the reset.
// Card rules are scoped to .card: baseCss styles .meta and .desc for the watch pages.
const BROWSE_CSS = `
header.intro{display:flex;align-items:baseline;gap:.2rem .8rem;flex-wrap:wrap;padding:0 0 .4rem}
header.intro h1{font-size:1.15rem;margin:0}
header.intro .sub{color:var(--muted);font-size:.85rem}
nav.tabs{display:flex;gap:.25rem;padding:.2rem 0 .7rem;flex-wrap:wrap}
nav.tabs a{color:var(--muted);text-decoration:none;padding:.45rem .9rem;border-radius:999px;font-size:.88rem;border:1px solid transparent}
nav.tabs a:hover{color:var(--text)}nav.tabs a.on{color:var(--on-accent-strong,#fff);background:var(--accent-strong,#1d4ed8)}
nav.tabs a .n{opacity:.75;font-size:.78rem;margin-left:.3rem}nav.tabs a.on .n{opacity:1}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:1rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
/* The preview keeps its 16:9 box whatever the picture's shape: a portrait recording's thumbnail used to set the box's
   minimum height (an aspect-ratio box grows to fit its content), stretching its card and its whole row to ~640 px. */
.card .thumb{position:relative;display:block;aspect-ratio:16/9;background:#0b0f18;overflow:hidden}
.card .thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.card .thumb .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.2rem;opacity:.5}
.card .thumb .dur{position:absolute;right:.5rem;bottom:.5rem;background:rgba(0,0,0,.75);color:#fff;padding:.1rem .45rem;border-radius:6px;font-size:.75rem}
.card .thumb .kind{position:absolute;left:.5rem;top:.5rem;background:rgba(var(--accent-rgb,59,130,246),.85);color:var(--on-accent,#fff);padding:.1rem .5rem;border-radius:6px;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
.card .meta{margin:0;padding:.7rem .8rem;display:flex;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:.35rem;flex:1;color:var(--text);font-size:inherit;line-height:1.5}
.card .title{font-weight:600;font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .desc{color:var(--muted);font-size:.8rem;white-space:normal;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card .foot{margin-top:auto;display:flex;justify-content:space-between;gap:.6rem;color:var(--muted);font-size:.74rem;flex-wrap:wrap}
.card .foot a{color:var(--acc);text-decoration:none}.card .foot a:hover{text-decoration:underline}
.pager{display:flex;gap:.5rem;justify-content:center;align-items:center;padding:1.4rem;color:var(--muted);font-size:.88rem}
.pg{color:var(--acc);text-decoration:none;padding:.35rem .8rem;border:1px solid var(--line);border-radius:8px}
.pg.dis{color:var(--muted);opacity:.4}
.empty{padding:3rem;text-align:center;color:var(--muted)}
/* The list's heading takes the showcase sections' face and size (openvibe-shared/showcase.css), like the rest of the home. */
.sec-h{font-family:var(--ov-font,'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif);font-size:clamp(22px,2.6vw,30px);letter-spacing:-.02em;margin:56px 0 .6rem}
.sc-media .sec-h{margin-top:0}   /* on the home the list is a showcase section, whose own margin spaces it */
.hero-stats{margin:0;display:grid;gap:10px}
.hero-stats div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.hero-stats dt{font-size:1.25rem;font-weight:700}.hero-stats dd{margin:2px 0 0;color:var(--muted);font-size:.92rem}
.faq{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:4px 16px;margin:8px 0}
.faq[open]{padding-bottom:12px}.faq summary{cursor:pointer;font-weight:600;padding:8px 0}.faq p{margin:4px 0 0;color:var(--muted)}
`;

const DESCRIPTION = 'Videos, clips, pictures and files for every OpenVibe site, and the same API for your apps: objects, S3, thumbnails in any size and HLS.';
const TITLE = 'OpenVibe.Media: open media and object storage';

/** The home's questions: shown on the first page and given to search engines as FAQPage data (the same text). */
const HOME_FAQ = [
    { q: 'Do I need an account to watch?', a: 'No. Public videos, clips, sounds and files play and download without an account; watch pages for recordings and clips are on OpenVibe.Video.' },
    { q: 'How does my app store files here?', a: 'Over S3 with a project key from OpenVibe.Zone (any S3 tool, endpoint s3.openvibe.media), or through the object API with the openvibe-sdk/media client: single or multipart uploads, resumable, signed URLs.' },
    { q: 'What sizes can a thumbnail be?', a: 'Any public thumbnail answers /t/<id>?w=<width>&fmt=<format>: widths 64, 96, 160, 320, 480 or 640, as WebP, AVIF or JPEG, made once and cached.' },
    { q: 'Can I show what a live stream looks like right now?', a: 'Yes: /live/@<username>/frame.jpg is a near-real-time frame of that streamer\'s live recording (?w= for a width, ?format=json for a status). When they are offline it is an offline card with a 404.' },
    { q: 'What happens to something I delete?', a: 'A deleted object can be restored for a while before it is purged; the limits below say for how long. Its thumbnails and copies go with it.' },
    { q: 'What are the limits?', a: 'They are published as JSON at /limits.json and in the table on this page: storage per project, upload and part sizes, and how long an unfinished upload holds its space.' },
];
function homeFaqJsonLd() {
    return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: HOME_FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<(\w+)>/g, '$1') } })) };
}
const bytes = (n) => { const v = Number(n) || 0; return v >= 1024 ** 3 ? `${+(v / 1024 ** 3).toFixed(1)} GB` : `${Math.round(v / 1024 ** 2)} MB`; };

/** The first page's developer half: what Media is for, how an app uses it, the limits it enforces, the questions. */
function developerSections() {
    const L = require('../limits').limitsOf(config).limits;
    const rows = L.filter((l) => ['storage_bytes', 'single_upload_bytes', 'multipart_bytes', 'part_bytes', 'unfinished_upload_hours', 'deleted_retention_days'].includes(l.id))
        .map((l) => ({ label: l.label, values: [l.unit === 'bytes' ? bytes(l.production) : `${l.production} ${l.unit}`, l.unit === 'bytes' ? bytes(l.sandbox) : `${l.sandbox} ${l.unit}`] }));
    return showcase.features({
        id: 'what',
        title: 'What it does',
        lede: 'The media layer under every OpenVibe site, open to your apps through the same API.',
        items: [
            { icon: 'ov:media', title: 'Objects and S3', text: 'Store any file in a project namespace: single or multipart uploads, signed URLs, and an S3 endpoint for the tools you have (through OpenVibe.Zone).', href: 'https://openvibe.zone/' },
            { icon: 'ov:video', title: 'Recordings and clips', text: 'Live recordings, clips cut from them or straight from the stream timeline, and clips trimmed in place. Watch pages are on OpenVibe.Video.', href: 'https://openvibe.video/' },
            { icon: 'ov:live', title: 'Streaming playback', text: 'Byte-range playback for every video, HLS for the ones that have a timeline, so players can seek without downloading.' },
            { icon: 'ov:pics', title: 'Thumbnails in any size', text: '/t/<id>?w=&fmt= gives WebP, AVIF or JPEG at six widths, so a card loads about half the bytes.' },
            { icon: 'ov:camera', title: 'Live frames', text: '/live/@<name>/frame.jpg: a near-real-time picture of a live stream, for embeds and bots.' },
            { icon: 'ov:check', title: 'Limits in public', text: 'Every limit Media enforces is published at /limits.json, the same numbers OpenVibe.Services and Zone show.', href: '/limits.json' },
        ],
    }) + showcase.code({
        id: 'api',
        title: 'From your app',
        lede: 'Public media needs no key. Your own objects take a project token or a Zone key.',
        samples: [
            { label: 'Thumbnail', lang: 'html', code: `<img src="${config.publicUrl}/t/<thumbnail>?w=320&fmt=webp" width="320" loading="lazy" alt="">
<img src="${config.publicUrl}/live/@goosely/frame.jpg?w=640" alt="goosely, live now">` },
            { label: 'Node (openvibe-sdk)', lang: 'js', code: `const { createObjectsClient } = require('openvibe-sdk/media');

// tokens: createServiceTokenClient() for your developer app; app is your project id
const objects = createObjectsClient({ app: 'prj_…', tokenClient: tokens });
const obj = await objects.upload(fs.readFileSync('q3.pdf'), { kind: 'file', mimeType: 'application/pdf', filename: 'q3.pdf' });
const { url } = await objects.signedUrl(obj.id, { ttl: 300 });` },
            { label: 'S3 (any tool)', lang: 'bash', code: `aws --endpoint-url https://s3.openvibe.media s3 cp ./site s3://assets/ --recursive   # a Zone key and zone` },
        ],
    }) + showcase.limits({
        title: 'Limits',
        lede: 'What one project gets in each environment.',
        columns: ['Production', 'Sandbox'],
        rows,
        source: `${config.publicUrl}/limits.json`,
    }) + `<section class="sc-sec" id="questions" aria-labelledby="faq-h"><h2 id="faq-h">Questions</h2>${HOME_FAQ.map((f) => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>`;
}

function renderPage(tab, page, data, counts) {
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    const nav = (p, label, dis) => dis ? `<span class="pg dis" aria-disabled="true">${label}</span>` : `<a class="pg" href="/?tab=${tab}&page=${p}">${label}</a>`;
    const first = tab === 'all' && page === 1;
    const canonical = `${config.publicUrl}/${first ? '' : `?tab=${tab}${page > 1 ? `&page=${page}` : ''}`}`;
    // The one <h1> on the page: the showcase hero on the index's front page, the plain intro elsewhere.
    const stats = [
        [counts.videos, 'public recordings and videos'], [counts.clips, 'public clips'],
        [counts.emotes + counts.sounds, 'emotes and sounds'], [counts.thumbnails, 'thumbnails in six sizes'],
    ].filter(([n]) => n > 0);
    const heading = first ? showcase.hero({
        eyebrow: 'OpenVibe.Media · part of OpenVibe Services',
        title: 'Open media and object storage',
        accent: 'for OpenVibe and your apps.',
        lede: 'Every video, clip, picture and file on the OpenVibe sites lives here, and your apps get the same API: objects and S3, thumbnails in any size, streaming playback and live frames. Public media plays and downloads without an account.',
        actions: [
            { label: 'Browse public media', href: '#media', primary: true },
            { label: 'Watch on OpenVibe.Video', href: 'https://openvibe.video/' },
            { label: 'Use it from your app', href: '#api' },
        ],
        html: stats.length ? `<dl class="hero-stats">${stats.map(([n, d]) => `<div><dt>${Number(n).toLocaleString('en-US')}</dt><dd>${d}</dd></div>`).join('')}</dl>` : undefined,
    }) + '<section class="sc-sec sc-part-of"><p class="sc-note">Part of <a href="https://openvibe.services/">OpenVibe Services</a>: the building blocks every OpenVibe product runs on, with one console, one account and one SDK.</p></section>' : '<header class="intro"><h1>Every public file on the network</h1><span class="sub">videos, clips, files &amp; thumbnails from all OpenVibe sites</span></header>';
    // On the home the list is a section like the ones around it (the same inset, so its heading, tabs and grid line up
    // with the hero and the developer sections); later pages and tabs keep the plain index layout.
    const list = `<nav class="tabs" aria-label="Media types">${TABS.map(([k, label]) => `<a class="${k === tab ? 'on' : ''}" href="/?tab=${k}">${label}<span class="n">${(counts[k] ?? 0).toLocaleString()}</span></a>`).join('')}</nav>
${data.cards.length ? `<div class="grid">${data.cards.map(renderCard).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}
<div class="pager">${nav(page - 1, '‹ Prev', page <= 1)}<span>Page ${page} / ${pages} · ${data.total.toLocaleString()} items</span>${nav(page + 1, 'Next ›', page >= pages)}</div>`;
    const body = `${heading}
${first ? `<section class="sc-sec sc-media" aria-labelledby="media"><h2 id="media" class="sec-h">Latest public media</h2>
${list}</section>` : list}
${first ? developerSections() : ''}
${first ? frame.shipped({ service: 'media', title: 'Recently shipped on OpenVibe.Media' }) : ''}`;
    return pageFrame.page({
        seo: {
            title: TITLE, description: DESCRIPTION, canonical,
            robots: page > 1 ? 'noindex, follow' : 'index, follow', ogType: 'website',
            jsonLd: page === 1 ? [...browseJsonLd(tab, data.cards), ...(first ? [homeFaqJsonLd()] : [])] : [],
        },
        css: BROWSE_CSS,
        body,
        // Later pages are noindex and carry no structured data, the summary's WebPage included.
        summary: page === 1 ? {
            summary: 'Index of all public media on the OpenVibe network: videos, clips, emotes, sounds, files and thumbnails, browsable and playable without an account.',
            url: canonical,
            facts: [['Items', data.total.toLocaleString('en-US')]],
            updated: isoDate(data.cards[0] && data.cards[0].date) || undefined,
        } : undefined,
        history: { type: 'page', title: 'OpenVibe.Media' },
        footer: { variant: 'full' },
    });
}

async function handle(req, res) {
    try {
        const tab = TABS.some(([k]) => k === req.query.tab) ? req.query.tab : 'all';
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const data = await fetchTab(tab, page);
        // The listing names media that can become private at any moment: no stale serving, or a cache
        // could still hand out the old listing afterwards.
        res.set({ 'Cache-Control': cache.htmlHeaders({ maxAge: 30, swr: 0 }), 'Content-Type': 'text/html; charset=utf-8' });
        res.send(renderPage(tab, page, data, await tabCounts()));
    } catch (err) {
        console.error('[Browse] render error:', err.message);
        res.status(500).send('Failed to render media index');
    }
}

module.exports = { handle };
