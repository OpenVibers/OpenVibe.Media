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
const { appUrl, isoDate } = pageFrame;
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
        source: `${appUrl(v.app_id)}/vod/${v.id}`, sourceLabel: 'VOD page',
    };
}
function clipCard(c) {
    return {
        kind: 'clip', title: c.title || `Clip #${c.id}`, date: c.created_at, app: c.app_id,
        thumb: abs(c.thumbnail_url), duration: c.duration_seconds,
        text: snip(c.description || c.ai_overview),
        view: `${config.publicUrl}/c/${c.id}`,
        source: `${appUrl(c.app_id)}/clip/${c.id}`, sourceLabel: 'Clip page',
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
        if (m[1] === 'vod') { source = `${base}/vod/${m[2]}`; sourceLabel = 'VOD page'; }
        else if (m[1] === 'clip') { source = `${base}/clip/${m[2]}`; sourceLabel = 'Clip page'; }
        else { source = `${base}/stream/${m[2]}`; sourceLabel = 'Stream'; }
    }
    return {
        kind: 'thumbnail', title: name, date: new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' '),
        thumb: `${config.publicUrl}/t/${encodeURIComponent(name)}`, text: '',
        view: `${config.publicUrl}/t/${encodeURIComponent(name)}`, source, sourceLabel,
    };
}

// ── Data per tab ─────────────────────────────────────────────
const V_WHERE = "is_public = 1 AND COALESCE(is_recording,0) = 0 AND COALESCE(clips_only,0) = 0";
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card .thumb{position:relative;display:block;aspect-ratio:16/9;background:#0b0f18}
.card .thumb img{width:100%;height:100%;object-fit:cover;display:block}
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
`;

const DESCRIPTION = 'Index of all public media on the OpenVibe network — videos, clips, files and thumbnails.';

function renderPage(tab, page, data, counts) {
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    const nav = (p, label, dis) => dis ? `<span class="pg dis" aria-disabled="true">${label}</span>` : `<a class="pg" href="/?tab=${tab}&page=${p}">${label}</a>`;
    const first = tab === 'all' && page === 1;
    const canonical = `${config.publicUrl}/${first ? '' : `?tab=${tab}${page > 1 ? `&page=${page}` : ''}`}`;
    // The one <h1> on the page: the showcase hero on the index's front page, the plain intro elsewhere.
    const heading = first ? showcase.hero({
        eyebrow: 'OpenVibe.Media',
        title: 'Every public file on the',
        accent: 'OpenVibe network',
        lede: 'Videos, clips, emotes, sounds, files and thumbnails from every OpenVibe site, in one index. Watch and download public media without an account.',
        actions: [
            { label: 'Browse videos', href: '/?tab=videos', primary: true },
            { label: 'Watch on OpenVibe.Live', href: appUrl('live') + '/' },
        ],
    }) : '<header class="intro"><h1>Every public file on the network</h1><span class="sub">videos, clips, files &amp; thumbnails from all OpenVibe sites</span></header>';
    const body = `${heading}
<nav class="tabs" aria-label="Media types">${TABS.map(([k, label]) => `<a class="${k === tab ? 'on' : ''}" href="/?tab=${k}">${label}<span class="n">${(counts[k] ?? 0).toLocaleString()}</span></a>`).join('')}</nav>
${data.cards.length ? `<div class="grid">${data.cards.map(renderCard).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}
<div class="pager">${nav(page - 1, '‹ Prev', page <= 1)}<span>Page ${page} / ${pages} · ${data.total.toLocaleString()} items</span>${nav(page + 1, 'Next ›', page >= pages)}</div>
${first ? frame.shipped({ service: 'media', title: 'Recently shipped on OpenVibe.Media' }) : ''}`;
    return pageFrame.page({
        seo: {
            title: 'OpenVibe.Media — Media Index', description: DESCRIPTION, canonical,
            robots: page > 1 ? 'noindex, follow' : 'index, follow', ogType: 'website',
            jsonLd: page === 1 ? browseJsonLd(tab, data.cards) : [],
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
