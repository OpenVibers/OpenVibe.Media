/**
 * OpenVibe.Media — public media index ("home page").
 *
 * Server-rendered browse UI at GET / — a mass index of every public piece of
 * media this service owns, tabbed by kind (Videos / Clips / Images / Text /
 * Thumbnails / Files), each card carrying its description / AI overview and a
 * link back to the SOURCE page in the owning app (the VOD / clip / stream /
 * paste it came from). Dependency-free: inline CSS, no client JS required.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db/database');

const PAGE_SIZE = 48;
const THUMB_DIR = path.resolve(config.thumbnails.path);

// Public base URL per app for "source" links (env-overridable JSON map).
const APP_PUBLIC_URLS = (() => {
    try { const m = JSON.parse(process.env.APP_PUBLIC_URLS || ''); if (m && typeof m === 'object') return m; } catch { /* */ }
    return {
        live: 'https://openvibe.live',
        games: 'https://openvibe.games',
        tools: 'https://openvibe.tools',
        network: 'https://openvibe.network',
    };
})();
const appUrl = (appId) => APP_PUBLIC_URLS[appId] || APP_PUBLIC_URLS.live;

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
function pasteCard(p) {
    const isImage = p.type === 'screenshot';
    return {
        kind: isImage ? 'image' : 'text', title: p.title || p.slug, date: p.created_at, app: p.app_id,
        thumb: isImage ? `${config.publicUrl}/p/${encodeURIComponent(p.slug)}/screenshot` : null,
        text: snip(isImage ? (p.content || p.description) : p.content),
        view: `${config.publicUrl}/p/${encodeURIComponent(p.slug)}`,
        source: `${appUrl(p.app_id)}/p/${encodeURIComponent(p.slug)}`, sourceLabel: 'Paste page',
        lang: p.language && p.language !== 'text' ? p.language : null,
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
const P_WHERE = "visibility = 'public'";

let _thumbListCache = { at: 0, list: [] };
function thumbList() {
    if (Date.now() - _thumbListCache.at < 60_000) return _thumbListCache.list;
    let list = [];
    try {
        list = fs.readdirSync(THUMB_DIR)
            .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
            .map(f => { try { return [f, fs.statSync(path.join(THUMB_DIR, f)).mtimeMs]; } catch { return null; } })
            .filter(Boolean)
            .sort((a, b) => b[1] - a[1]);
    } catch { /* */ }
    _thumbListCache = { at: Date.now(), list };
    return list;
}

function fetchTab(tab, page) {
    const off = (page - 1) * PAGE_SIZE;
    const L = `ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${off}`;
    switch (tab) {
        case 'videos': return {
            total: db.get(`SELECT COUNT(*) c FROM vods WHERE ${V_WHERE}`).c,
            cards: db.all(`SELECT * FROM vods WHERE ${V_WHERE} ${L}`).map(vodCard),
        };
        case 'clips': return {
            total: db.get(`SELECT COUNT(*) c FROM clips WHERE ${C_WHERE}`).c,
            cards: db.all(`SELECT * FROM clips WHERE ${C_WHERE} ${L}`).map(clipCard),
        };
        case 'images': return {
            total: db.get(`SELECT COUNT(*) c FROM pastes WHERE ${P_WHERE} AND type = 'screenshot'`).c,
            cards: db.all(`SELECT * FROM pastes WHERE ${P_WHERE} AND type = 'screenshot' ${L}`).map(pasteCard),
        };
        case 'text': return {
            total: db.get(`SELECT COUNT(*) c FROM pastes WHERE ${P_WHERE} AND COALESCE(type,'paste') <> 'screenshot'`).c,
            cards: db.all(`SELECT * FROM pastes WHERE ${P_WHERE} AND COALESCE(type,'paste') <> 'screenshot' ${L}`).map(pasteCard),
        };
        case 'files': return {
            total: db.get('SELECT COUNT(*) c FROM files').c,
            cards: db.all(`SELECT * FROM files ${L}`).map(fileCard),
        };
        case 'emotes': return {
            total: db.get("SELECT COUNT(*) c FROM assets WHERE kind = 'emote'").c,
            cards: db.all(`SELECT * FROM assets WHERE kind = 'emote' ${L}`).map(assetCard),
        };
        case 'sounds': return {
            total: db.get("SELECT COUNT(*) c FROM assets WHERE kind = 'sound'").c,
            cards: db.all(`SELECT * FROM assets WHERE kind = 'sound' ${L}`).map(assetCard),
        };
        case 'thumbnails': {
            const list = thumbList();
            return { total: list.length, cards: list.slice(off, off + PAGE_SIZE).map(([f, t]) => thumbCard(f, t)) };
        }
        default: { // all — one unified reverse-chronological index across DB-backed media
            const rows = db.all(`
                SELECT 'vod' k, id ref, title, description, ai_overview, thumbnail_url, duration_seconds, created_at, app_id, NULL slug, NULL type, NULL content, NULL language FROM vods WHERE ${V_WHERE}
                UNION ALL
                SELECT 'clip', id, title, description, ai_overview, thumbnail_url, duration_seconds, created_at, app_id, NULL, NULL, NULL, NULL FROM clips WHERE ${C_WHERE}
                UNION ALL
                SELECT 'paste', id, title, NULL, NULL, NULL, NULL, created_at, app_id, slug, type, substr(COALESCE(content,''),1,300), language FROM pastes WHERE ${P_WHERE}
                UNION ALL
                SELECT 'asset', id, name, username, channel_username, kind, duration_seconds, created_at, app_id, NULL, NULL, NULL, NULL FROM assets
                ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${off}`);
            const total = db.get(`SELECT
                (SELECT COUNT(*) FROM vods WHERE ${V_WHERE}) +
                (SELECT COUNT(*) FROM clips WHERE ${C_WHERE}) +
                (SELECT COUNT(*) FROM pastes WHERE ${P_WHERE}) +
                (SELECT COUNT(*) FROM assets) c`).c;
            const cards = rows.map(r => r.k === 'vod' ? vodCard({ ...r, id: r.ref })
                : r.k === 'clip' ? clipCard({ ...r, id: r.ref })
                : r.k === 'asset' ? assetCard({ id: r.ref, name: r.title, username: r.description, channel_username: r.ai_overview, kind: r.thumbnail_url, duration_seconds: r.duration_seconds, created_at: r.created_at, app_id: r.app_id })
                : pasteCard({ ...r, id: r.ref }));
            return { total, cards };
        }
    }
}

let _countCache = { at: 0, counts: null };
function tabCounts() {
    if (_countCache.counts && Date.now() - _countCache.at < 60_000) return _countCache.counts;
    const c = (sql) => { try { return db.get(sql).c; } catch { return 0; } };
    const counts = {
        videos: c(`SELECT COUNT(*) c FROM vods WHERE ${V_WHERE}`),
        clips: c(`SELECT COUNT(*) c FROM clips WHERE ${C_WHERE}`),
        images: c(`SELECT COUNT(*) c FROM pastes WHERE ${P_WHERE} AND type = 'screenshot'`),
        text: c(`SELECT COUNT(*) c FROM pastes WHERE ${P_WHERE} AND COALESCE(type,'paste') <> 'screenshot'`),
        files: c('SELECT COUNT(*) c FROM files'),
        emotes: c("SELECT COUNT(*) c FROM assets WHERE kind = 'emote'"),
        sounds: c("SELECT COUNT(*) c FROM assets WHERE kind = 'sound'"),
        thumbnails: thumbList().length,
    };
    counts.all = counts.videos + counts.clips + counts.images + counts.text + counts.emotes + counts.sounds;
    _countCache = { at: Date.now(), counts };
    return counts;
}

// ── Rendering ────────────────────────────────────────────────
const KIND_ICON = { video: '🎬', clip: '✂️', image: '🖼️', text: '📄', thumbnail: '🏞️', file: '📦' };

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

const TABS = [['all', 'All'], ['videos', 'Videos'], ['clips', 'Clips'], ['images', 'Images'], ['text', 'Text'], ['emotes', 'Emotes'], ['sounds', 'Sounds'], ['thumbnails', 'Thumbnails'], ['files', 'Files']];

function renderPage(tab, page, data, counts) {
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    const nav = (p, label, dis) => dis ? `<span class="pg dis">${label}</span>` : `<a class="pg" href="/?tab=${tab}&page=${p}">${label}</a>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenVibe.Media — Media Index</title>
<meta name="description" content="Index of all public media on the OpenVibe network — videos, clips, images, pastes, and thumbnails.">
<!-- Critical theme bootstrap (ov-theme-boot) — inline and above the styles, so the cached
     theme paints on the first frame instead of flashing the default palette. -->
<script>
(function(){try{var raw=localStorage.getItem('ov_theme');if(!raw)return;var t=JSON.parse(raw),v=t&&t.variables;if(!v)return;var el=document.documentElement;for(var k in v)if(k.charAt(0)==='-')el.style.setProperty(k,v[k]);if(t.id)el.setAttribute('data-theme',t.id);}catch(_){}})();
</script>
<style>
:root{--bg:#0f1420;--panel:#161c2c;--border:#232b40;--text:#e6e9f2;--muted:#9aa3b8;--accent:#8b5cf6}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,'Segoe UI',Arial,sans-serif;padding-bottom:3rem}
header{display:flex;align-items:center;gap:.9rem;padding:1rem 1.4rem;border-bottom:1px solid var(--border);background:rgba(15,20,32,.92)}
header .logo{width:30px;height:30px}
header h1{font-size:1.15rem}header h1 b{color:var(--accent)}
header .sub{color:var(--muted);font-size:.82rem;margin-left:auto}
nav{display:flex;gap:.25rem;padding:.7rem 1.4rem;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;padding:.45rem .9rem;border-radius:999px;font-size:.88rem;border:1px solid transparent}
nav a:hover{color:var(--text)}nav a.on{color:#fff;background:var(--accent)}
nav a .n{opacity:.75;font-size:.78rem;margin-left:.3rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1rem;padding:0 1.4rem}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.thumb{position:relative;display:block;aspect-ratio:16/9;background:#0b0f18}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.2rem;opacity:.5}
.thumb .dur{position:absolute;right:.5rem;bottom:.5rem;background:rgba(0,0,0,.75);padding:.1rem .45rem;border-radius:6px;font-size:.75rem}
.thumb .kind{position:absolute;left:.5rem;top:.5rem;background:rgba(139,92,246,.85);color:#fff;padding:.1rem .5rem;border-radius:6px;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
.meta{padding:.7rem .8rem;display:flex;flex-direction:column;gap:.35rem;flex:1}
.title{font-weight:600;font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.desc{color:var(--muted);font-size:.8rem;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.foot{margin-top:auto;display:flex;justify-content:space-between;gap:.6rem;color:var(--muted);font-size:.74rem;flex-wrap:wrap}
.foot a{color:var(--accent);text-decoration:none}.foot a:hover{text-decoration:underline}
.pager{display:flex;gap:.5rem;justify-content:center;align-items:center;padding:1.4rem;color:var(--muted);font-size:.88rem}
.pg{color:var(--accent);text-decoration:none;padding:.35rem .8rem;border:1px solid var(--border);border-radius:8px}
.pg.dis{color:var(--muted);opacity:.4}
.empty{padding:3rem;text-align:center;color:var(--muted)}
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
</head><body>
<script src="https://openvibe.network/shared/navbar.js"></script>
<script>try { OpenVibeNavbar.init({ service: 'media' }); } catch (e) { /* navbar optional */ }</script>
<header>
  <svg class="logo" viewBox="0 0 100 100" fill="none" stroke="#8b5cf6" stroke-width="7"><circle cx="28" cy="66" r="11"/><circle cx="72" cy="66" r="11"/><circle cx="50" cy="30" r="11"/><line x1="34" y1="58" x2="45" y2="40"/><line x1="66" y1="58" x2="55" y2="40"/><line x1="39" y1="66" x2="61" y2="66"/></svg>
  <h1>OpenVibe<b>.Media</b></h1>
  <span class="sub">every public file on the network — videos, clips, images, pastes &amp; thumbnails</span>
</header>
<nav>${TABS.map(([k, label]) => `<a class="${k === tab ? 'on' : ''}" href="/?tab=${k}">${label}<span class="n">${(counts[k] ?? 0).toLocaleString()}</span></a>`).join('')}</nav>
${data.cards.length ? `<div class="grid">${data.cards.map(renderCard).join('')}</div>` : '<div class="empty">Nothing here yet.</div>'}
<div class="pager">${nav(page - 1, '‹ Prev', page <= 1)}<span>Page ${page} / ${pages} · ${data.total.toLocaleString()} items</span>${nav(page + 1, 'Next ›', page >= pages)}</div>
</body></html>`;
}

function handle(req, res) {
    try {
        const tab = TABS.some(([k]) => k === req.query.tab) ? req.query.tab : 'all';
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const data = fetchTab(tab, page);
        res.set({ 'Cache-Control': 'public, max-age=30', 'Content-Type': 'text/html; charset=utf-8' });
        res.send(renderPage(tab, page, data, tabCounts()));
    } catch (err) {
        console.error('[Browse] render error:', err.message);
        res.status(500).send('Failed to render media index');
    }
}

module.exports = { handle };
