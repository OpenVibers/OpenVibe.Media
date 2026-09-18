/**
 * OpenVibe.Media — the human-facing pages behind the public URLs.
 *
 *   /v/:id and /c/:id are, first of all, the media bytes (players, <video>
 *   tags, curl, the object-store redirect). A browser NAVIGATING there — a
 *   shared link, the address bar, a link-preview crawler — gets a watch page
 *   instead: player, title, source link and full SEO. wantsHtmlPage() draws
 *   that line; ?raw=1 always yields the bytes.
 *
 *   /p/:slug is a thin viewer. Pastes are canonical on OpenVibe.Community,
 *   which renders them from this API, so the page here points there
 *   (canonical + noindex) and stays useful for direct links.
 */
'use strict';

const path = require('path');
const config = require('../config');
const chrome = require('./page-chrome');

const { esc, abs, snip, appUrl, isoDate, isoDuration, fmtDuration, fmtDate, SITE_NAME, NETWORK_URL } = chrome;

const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
/** Link-preview and search crawlers: they want the page, never the bytes. */
const PAGE_BOTS = /facebookexternalhit|twitterbot|discordbot|slackbot|linkedinbot|whatsapp|telegrambot|googlebot|bingbot|applebot|duckduckbot|yandex|pinterest|redditbot|mastodon|embedly/i;

/**
 * True when the request is a top-level browser navigation (or a preview
 * crawler) that should see the watch page rather than the media bytes.
 * Players and fetches (Sec-Fetch-Dest: video / empty, Accept without
 * text/html, Range requests) always get the bytes, as does ?raw=1.
 */
function wantsHtmlPage(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.query && (req.query.raw != null || req.query.download != null)) return false;
    if (req.headers.range) return false;
    const dest = req.headers['sec-fetch-dest'];
    if (dest) return dest === 'document';
    if (PAGE_BOTS.test(String(req.headers['user-agent'] || ''))) return true;
    const accept = String(req.headers.accept || '');
    return /(^|,)\s*text\/html/.test(accept);
}

function creatorLine(record) {
    // Media stores the owning app's user id only; the app's page carries the name.
    return record.username || record.display_name || null;
}

/** Where the owning app shows this item — Live's /vod and /clip pages. */
function sourcePage(kind, record) {
    const base = appUrl(record.app_id || 'live');
    return `${base}/${kind === 'vod' ? 'vod' : 'clip'}/${record.id}`;
}

/**
 * /v/:id and /c/:id as a page. Canonical stays with the owning app when that
 * app serves the item (Live's /vod/:id and /clip/:id); anything else is
 * self-canonical here.
 */
function renderWatchPage(kind, record) {
    const isVod = kind === 'vod';
    const id = record.id;
    const self = `${config.publicUrl}/${isVod ? 'v' : 'c'}/${id}`;
    const rawUrl = `${self}?raw=1`;
    const title = snip(record.title || (isVod ? `VOD #${id}` : `Clip #${id}`), 120);
    const by = creatorLine(record);
    const description = snip(record.description || record.ai_overview || `${isVod ? 'A recorded live stream' : 'A clip'}${by ? ` by ${by}` : ''} on the OpenVibe network.`, 200);
    const thumb = abs(record.thumbnail_url);
    const ownedByLive = (record.app_id || 'live') === 'live';
    const canonical = ownedByLive ? sourcePage(kind, record) : self;
    const visibility = record.visibility || (record.is_public ? 'public' : 'private');
    // The owning app has the canonical page; unlisted items never index.
    const robots = ownedByLive || visibility !== 'public' ? 'noindex, follow' : 'index, follow';
    const mime = VIDEO_MIME[path.extname(record.file_path || '').toLowerCase()] || 'video/mp4';
    const uploadDate = isoDate(record.created_at);
    const duration = isoDuration(record.duration_seconds);

    const videoObject = {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: title,
        description,
        url: canonical,
        contentUrl: rawUrl,
        embedUrl: self,
        ...(thumb ? { thumbnailUrl: [thumb] } : {}),
        ...(uploadDate ? { uploadDate } : {}),
        ...(duration ? { duration } : {}),
        ...(by ? { author: { '@type': 'Person', name: by } } : {}),
        ...(record.view_count ? { interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: record.view_count } } : {}),
        publisher: { '@type': 'Organization', name: 'OpenVibe', url: NETWORK_URL },
        isFamilyFriendly: true,
    };

    const metaBits = [
        isVod ? 'VOD' : 'Clip',
        record.duration_seconds ? fmtDuration(record.duration_seconds) : null,
        record.view_count != null ? `${Number(record.view_count).toLocaleString('en-US')} views` : null,
        fmtDate(record.created_at) || null,
        by ? `by ${esc(by)}` : null,
    ].filter(Boolean);

    const body = `
  <h1>${esc(title)}</h1>
  <p class="meta">${metaBits.map(b => `<span>${b}</span>`).join('<span aria-hidden="true">·</span>')}</p>
  <div class="player">
    <video controls playsinline preload="metadata"${thumb ? ` poster="${esc(thumb)}"` : ''} src="${esc(rawUrl)}">
      Your browser cannot play this video. <a href="${esc(rawUrl)}">Download it</a> instead.
    </video>
  </div>
  <div class="actions">
    ${ownedByLive ? `<a class="btn" href="${esc(canonical)}">${isVod ? 'Watch on OpenVibe.Live' : 'Watch on OpenVibe.Live'} — chat, transcript &amp; more</a>` : ''}
    <a class="btn ghost" href="${esc(rawUrl)}" download>Download ${isVod ? 'VOD' : 'clip'}</a>
    ${isVod ? `<a class="btn ghost" href="${esc(`${self}/transcript.json`)}">Transcript (JSON)</a>` : ''}
  </div>
  ${record.description ? `<p class="desc">${esc(snip(record.description, 2000))}</p>` : ''}
  ${record.ai_overview && record.ai_overview !== record.description ? `<section><h2 class="h2">Overview</h2><p class="desc">${esc(snip(record.ai_overview, 3000))}</p></section>` : ''}`;

    const css = `
  .player { background: #000; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); margin: 0 0 1rem; }
  .player video { display: block; width: 100%; max-height: 72vh; background: #000; }
  .h2 { font-size: 1rem; margin: 1.2rem 0 .3rem; color: var(--text); }`;

    return chrome.page({
        seo: {
            title: `${title} — ${SITE_NAME}`, description, canonical, robots,
            image: thumb || undefined, ogType: 'video.other',
            video: { url: rawUrl, type: mime },
            jsonLd: [videoObject],
        },
        css, body,
        history: { type: isVod ? 'vod' : 'clip', title },
        footer: { variant: 'compact' },
    });
}

/** /p/:slug — thin viewer; the page's home is OpenVibe.Community. */
function renderPastePage(paste) {
    const slug = String(paste.slug);
    const title = snip(paste.title || 'Untitled', 120);
    const isScreenshot = paste.type === 'screenshot' && paste.screenshot_path;
    const self = `${config.publicUrl}/p/${encodeURIComponent(slug)}`;
    const communityUrl = `${appUrl('community')}/p/${encodeURIComponent(slug)}`;
    const screenshotUrl = `${self}/screenshot`;
    const language = paste.language || 'text';
    const description = snip(paste.ai_summary || (isScreenshot ? (paste.content || `Screenshot "${title}" shared on the OpenVibe network.`) : (paste.content || `${language} paste shared on the OpenVibe network.`)), 200);
    const created = isoDate(paste.created_at);
    const updated = isoDate(paste.updated_at) || created;
    const tags = (() => { try { const t = JSON.parse(paste.ai_tags || '[]'); return Array.isArray(t) ? t.map(String).slice(0, 12) : []; } catch { return String(paste.ai_tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 12); } })();

    const ld = isScreenshot
        ? {
            '@context': 'https://schema.org', '@type': 'ImageObject',
            name: title, description, url: communityUrl, contentUrl: screenshotUrl, mainEntityOfPage: communityUrl,
            ...(created ? { datePublished: created } : {}), ...(updated ? { dateModified: updated } : {}),
            ...(tags.length ? { keywords: tags.join(', ') } : {}),
            publisher: { '@type': 'Organization', name: 'OpenVibe', url: NETWORK_URL },
        }
        : {
            '@context': 'https://schema.org', '@type': 'Article',
            headline: title, description, url: communityUrl, mainEntityOfPage: communityUrl,
            ...(created ? { datePublished: created } : {}), ...(updated ? { dateModified: updated } : {}),
            ...(tags.length ? { keywords: tags.join(', ') } : {}),
            genre: language === 'text' ? 'Text paste' : `${language} code paste`,
            isAccessibleForFree: true,
            hasPart: { '@type': 'CreativeWork', name: title, encodingFormat: 'text/plain', url: `${self}/raw` },
            publisher: { '@type': 'Organization', name: 'OpenVibe', url: NETWORK_URL },
        };

    const content = isScreenshot
        ? `<figure class="shot"><img src="${esc(screenshotUrl)}" alt="${esc(title)}" loading="lazy"></figure>
  ${paste.content ? `<p class="desc">${esc(paste.content)}</p>` : ''}`
        : `<pre class="code" data-language="${esc(language)}"><code>${esc(paste.content || '')}</code></pre>`;

    const metaBits = [
        esc(language),
        `${Number(paste.views || 0).toLocaleString('en-US')} views`,
        paste.unique_views != null ? `${Number(paste.unique_views).toLocaleString('en-US')} unique` : null,
        fmtDate(paste.created_at) || null,
        isScreenshot ? null : `<a href="${esc(`/p/${encodeURIComponent(slug)}/raw`)}">raw</a>`,
    ].filter(Boolean);

    const body = `
  <p class="note">This paste lives on <a href="${esc(communityUrl)}">OpenVibe.Community</a> — comments, likes and forks are there. This is the plain viewer.</p>
  <h1>${esc(title)}</h1>
  <p class="meta">${metaBits.map(b => `<span>${b}</span>`).join('<span aria-hidden="true">·</span>')}</p>
  ${content}
  <div class="actions"><a class="btn" href="${esc(communityUrl)}">Open on OpenVibe.Community</a></div>`;

    const css = `
  .code { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem; overflow-x: auto; white-space: pre; font: 13px/1.5 ui-monospace, 'Cascadia Code', Menlo, monospace; margin: 0 0 1rem; }
  .shot { margin: 0 0 1rem; }
  .shot img { max-width: 100%; border-radius: 10px; border: 1px solid var(--line); }`;

    return chrome.page({
        seo: {
            title: `${title} — ${SITE_NAME}`, description,
            // Canonical on Community: search engines index the paste there, not here.
            canonical: communityUrl, robots: 'noindex, follow',
            image: isScreenshot ? screenshotUrl : undefined, ogType: 'article',
            twitterCard: isScreenshot ? 'summary_large_image' : 'summary',
            jsonLd: [ld],
        },
        css, body,
        history: { type: 'paste', title },
        footer: { variant: 'compact' },
    });
}

module.exports = { wantsHtmlPage, renderWatchPage, renderPastePage, sourcePage };
