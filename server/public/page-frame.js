/**
 * OpenVibe.Media — the shell every server-rendered page shares.
 *
 * One place for: the OpenVibe Frame (openvibe.network's theme-loader before
 * paint, navbar + footer after), the SEO head (title, description, canonical,
 * robots, Open Graph, Twitter card, JSON-LD) and the page palette, which
 * reads the shared theme tokens (--bg-primary, --accent, …) that
 * theme-loader.js sets on <html> and falls back to the default Vibe palette.
 */
'use strict';

const config = require('../config');
const ovServe = require('openvibe-shared/serve');

const NETWORK_URL = (config.network && config.network.url) || 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Media';
const DEFAULT_OG_IMAGE = `${config.publicUrl}/og-image.png`;

// Public base URL per app for canonical / "source" links (env-overridable JSON map).
const APP_PUBLIC_URLS = (() => {
    const defaults = {
        live: 'https://openvibe.live',
        games: 'https://openvibe.games',
        tools: 'https://openvibe.tools',
        network: NETWORK_URL,
        community: process.env.COMMUNITY_PUBLIC_URL || 'https://openvibe.community',
    };
    try {
        const m = JSON.parse(process.env.APP_PUBLIC_URLS || '');
        if (m && typeof m === 'object') return { ...defaults, ...m };
    } catch { /* unset or malformed: defaults */ }
    return defaults;
})();
const appUrl = (appId) => APP_PUBLIC_URLS[appId] || APP_PUBLIC_URLS.live;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const abs = (u) => (!u ? null : (/^https?:\/\//i.test(u) ? u : `${config.publicUrl}${u.startsWith('/') ? '' : '/'}${u}`));
const snip = (s, n = 200) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
/** JSON that is safe inside a <script>: no `</` can end the element early. */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) → ISO 8601, or null. */
function isoDate(dt) {
    if (!dt) return null;
    const d = new Date(String(dt).includes('T') ? dt : `${dt}Z`.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** Seconds → ISO 8601 duration (PT1H2M3S), or null. */
function isoDuration(sec) {
    sec = Math.floor(Number(sec) || 0);
    if (sec <= 0) return null;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${s || (!h && !m) ? s + 'S' : ''}`;
}
function fmtDuration(sec) {
    sec = Math.floor(Number(sec) || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDate(dt) {
    const iso = isoDate(dt);
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch { return iso.slice(0, 10); }
}

/**
 * The <head> a page needs: shared theme before paint, then the SEO set.
 *   title, description, canonical (absolute), robots, image (absolute),
 *   ogType, jsonLd (array of objects), video ({ url, type, width, height }).
 */
function headTags(seo) {
    const title = esc(seo.title);
    const description = esc(snip(seo.description, 300));
    const image = seo.image || DEFAULT_OG_IMAGE;
    const twitterCard = seo.twitterCard || 'summary_large_image';
    const tags = [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${title}</title>`,
        `<meta name="description" content="${description}">`,
        // Applies the user's theme to <html> synchronously; must run before any CSS paints.
        require('openvibe-shared/app-icon').headTags({ site: 'media', iconBase: '/assets' }),
        `<script src="${ovServe.url('theme-loader.js')}" defer></script>`,
        seo.canonical ? `<link rel="canonical" href="${esc(seo.canonical)}">` : '',
        `<meta name="robots" content="${esc(seo.robots || 'index, follow')}">`,
        `<meta property="og:site_name" content="${SITE_NAME}">`,
        `<meta property="og:type" content="${esc(seo.ogType || 'website')}">`,
        `<meta property="og:title" content="${title}">`,
        `<meta property="og:description" content="${description}">`,
        seo.canonical ? `<meta property="og:url" content="${esc(seo.canonical)}">` : '',
        `<meta property="og:image" content="${esc(image)}">`,
        image === DEFAULT_OG_IMAGE ? '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : '',
        seo.video && seo.video.url ? [
            `<meta property="og:video" content="${esc(seo.video.url)}">`,
            `<meta property="og:video:secure_url" content="${esc(seo.video.url)}">`,
            seo.video.type ? `<meta property="og:video:type" content="${esc(seo.video.type)}">` : '',
        ].join('\n') : '',
        `<meta name="twitter:card" content="${esc(twitterCard)}">`,
        `<meta name="twitter:title" content="${title}">`,
        `<meta name="twitter:description" content="${description}">`,
        `<meta name="twitter:image" content="${esc(image)}">`,
        ...(seo.jsonLd || []).map(obj => `<script type="application/ld+json">${jsonForScript(obj)}</script>`),
    ];
    return tags.filter(Boolean).join('\n');
}

/** Page palette on the shared theme tokens (fallback: the default Vibe theme). */
function baseCss() {
    return `
  :root { --bg: var(--bg-primary, #0a0f1c); --panel: var(--bg-card, #131c2e); --line: var(--border, #1f2d47);
          --text: var(--text-primary, #e6edf7); --muted: var(--text-secondary, #96a7c2);
          --link: var(--accent-light, #60a5fa); --acc: var(--accent, #3b82f6); --on-acc: var(--on-accent, #fff); }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif; display: flex; flex-direction: column; min-height: 100vh; }
  main { width: 100%; max-width: 1040px; margin: 0 auto; padding: 1.2rem 16px 2rem; flex: 1 0 auto; }
  a { color: var(--link); }
  h1 { font-size: 1.35rem; line-height: 1.3; margin: .2rem 0 .4rem; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: .86rem; margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: .25rem .6rem; align-items: center; }
  .meta a { text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .note { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: .7rem 1rem; margin: 0 0 1rem; color: var(--muted); font-size: .9rem; }
  .note a { font-weight: 600; }
  .btn { display: inline-block; padding: .5rem .95rem; border-radius: 10px; background: var(--acc); color: var(--on-acc); text-decoration: none; font-weight: 600; font-size: .9rem; }
  .btn.ghost { background: transparent; color: var(--link); border: 1px solid var(--line); }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1rem; }
  .desc { color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  #ov-footer { flex: none; }
`;
}

/**
 * The scripts that mount the navbar + footer, after the page content so a
 * slow Network never blocks the body.
 *   history  { type, title } → recorded to the signed-in user's network history
 *   footer   { variant: 'full' | 'compact', links: [{ heading, items: [{ label, href }] }] }
 */
function frameScripts({ history, footer } = {}) {
    const navOpts = { service: 'media', apiBase: NETWORK_URL, silentLogin: `${config.publicUrl}/auth/login?silent=1&next={url}`, fedcmLogin: `${config.publicUrl}/auth/fedcm`, loginUrl: `${config.publicUrl}/auth/login?next={url}`, logoutUrl: '/auth/logout?next={path}', sessionUrl: '/auth/me' };
    if (history) navOpts.history = history;
    // The account menu's section for this site: the signed-in person's own media (server/me/, WS-G task 12).
    navOpts.menu = { before: [{ id: 'media-mine', label: 'Your media', href: '/me', icon: 'fa-photo-film' }] };
    const footOpts = {
        service: 'media',
        variant: (footer && footer.variant) || 'compact',
        links: (footer && footer.links) || defaultFooterLinks(),
        mount: '#ov-footer',
        updates: '/updates',   // the footer's "shipped X ago" line and Updates link open this site's log
    };
    return `<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
<script>
(function () {
  var tries = 0;
  function boot() {
    if (!window.OpenVibeNavbar || !window.OpenVibeFooter) { if (++tries < 60) setTimeout(boot, 100); return; }
    try { OpenVibeNavbar.init(${jsonForScript(navOpts)}); } catch (e) { /* navbar optional */ }
    try { OpenVibeFooter.init(${jsonForScript(footOpts)}); } catch (e) { /* footer optional */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
</script>`;
}

function defaultFooterLinks() {
    return [
        {
            heading: 'Media',
            // The shared footer's items are { name, url } (label/href rendered as empty links).
            items: [
                { name: 'Media index', url: `${config.publicUrl}/` },
                { name: 'Videos', url: `${config.publicUrl}/?tab=videos` },
                { name: 'Clips', url: `${config.publicUrl}/?tab=clips` },
                { name: 'Pastes', url: `${appUrl('community')}/pastes` },
            ],
        },
    ];
}

/**
 * A whole document: `seo` → headTags, `css` extra styles, `body` the <main>
 * contents, `history` / `footer` → frameScripts.
 */
function page({ seo, css = '', body, history, footer }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
${headTags(seo)}
<style>${baseCss()}${css}</style>
</head>
<body>
<div id="navbar-mount"></div>${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Media', links: [{ label: 'Videos', href: '/?tab=videos' }, { label: 'Clips', href: '/?tab=clips' }] })}
<main>
${body}
</main>
${require('openvibe-shared/frame').footer({ service: 'media', variant: 'compact', updates: '/updates' })}
${frameScripts({ history, footer })}
</body>
</html>`;
}

module.exports = {
    NETWORK_URL, SITE_NAME, DEFAULT_OG_IMAGE, APP_PUBLIC_URLS, appUrl,
    esc, abs, snip, isoDate, isoDuration, fmtDuration, fmtDate, jsonForScript,
    headTags, baseCss, frameScripts, defaultFooterLinks, page,
};
