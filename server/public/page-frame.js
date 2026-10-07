/**
 * OpenVibe.Media — the shared layout for every server-rendered page (the T11 sweep).
 *
 * `page()` composes the document through openvibe-shared/shell: the shell owns the doctype and <head>
 * (openvibe-shared/seo: title, description, canonical, robots, Open Graph/Twitter, JSON-LD), the
 * theme-loader before paint, the deferred web runtime/navbar/footer, the no-JavaScript nav and the
 * shared footer. This module supplies what the shell does not: the site's navbar options (sign-in,
 * history, the account menu's "Your media"), the server-rendered footer's links, the app icon, the
 * Open Graph video tags and the page palette, which reads the shared theme tokens (--bg-primary,
 * --accent, …) that theme-loader.js sets on <html> and falls back to the default Vibe palette.
 */
'use strict';

const config = require('../config');
const ovServe = require('openvibe-shared/serve');
const shell = require('openvibe-shared/shell');
const appIcon = require('openvibe-shared/app-icon');

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

/** ISO 8601 from a "YYYY-MM-DD HH:MM:SS" (UTC) text timestamp, as the migrations store them, or null. */
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
 * The site-specific <head> additions the shared shell does not own: the app icon, the page palette,
 * and the Open Graph video tags (openvibe-shared/seo has no video fields). `page()` passes this as
 * `shell.page`'s `head`, so the shell still owns title, description, canonical, robots, og/twitter
 * mirroring and JSON-LD.
 */
function extraHead(seo, css) {
    const image = seo.image || DEFAULT_OG_IMAGE;
    const videoTags = seo.video && seo.video.url ? [
        `<meta property="og:video" content="${esc(seo.video.url)}">`,
        `<meta property="og:video:secure_url" content="${esc(seo.video.url)}">`,
        seo.video.type ? `<meta property="og:video:type" content="${esc(seo.video.type)}">` : '',
    ].filter(Boolean).join('\n') : '';
    return [
        appIcon.headTags({ site: 'media', iconBase: '/assets' }),
        `<style>${baseCss()}${css}</style>`,
        videoTags,
        // The default share card is 1200×630; a media thumbnail carries its own dimensions.
        image === DEFAULT_OG_IMAGE ? '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : '',
    ].filter(Boolean).join('\n');
}

/** Page palette on the shared theme tokens (fallback: the default Vibe theme). */
// The default theme's tokens (openvibe-shared DEFAULT_VARS), so a page paints with them when openvibe.network,
// where the theme loader lives, cannot be reached (ADR-024). The loader's per-person values, set on <html>,
// override them.
const DEFAULT_THEME_CSS = (() => {
    try {
        const vars = require('openvibe-shared/builtin-themes').DEFAULT_VARS || {};
        return Object.entries(vars).filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && /^[#a-z0-9%.,()\s/+-]+$/i.test(String(v))).map(([k, v]) => `${k}:${v}`).join(';');
    } catch { return ''; }
})();

function baseCss() {
    return `
  ${DEFAULT_THEME_CSS ? `:root { ${DEFAULT_THEME_CSS} }` : ''}
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
 * openvibe-shared/shell's `navbar` option: this site's OpenVibeNavbar.init config.
 *   history  { type, title } → recorded to the signed-in user's network history
 */
function navOptions({ history } = {}) {
    const navOpts = { service: 'media', apiBase: NETWORK_URL, silentLogin: `${config.publicUrl}/auth/login?silent=1&next={url}`, fedcmLogin: `${config.publicUrl}/auth/fedcm`, loginUrl: `${config.publicUrl}/auth/login?next={url}`, logoutUrl: '/auth/logout?next={path}', sessionUrl: '/auth/me' };
    if (history) navOpts.history = history;
    // The account menu's section for this site: the signed-in person's own media (server/me/, WS-G task 12).
    navOpts.menu = { before: [{ id: 'media-mine', label: 'Your media', href: '/me', icon: 'fa-photo-film' }] };
    return navOpts;
}

/** openvibe-shared/shell's `footer` option (openvibe-shared/frame.footer on the server). */
function footerOptions(footer) {
    return {
        service: 'media',
        variant: (footer && footer.variant) || 'compact',
        links: (footer && footer.links) || defaultFooterLinks(),
        mount: '#ov-footer',
        updates: '/updates',   // the footer's "shipped X ago" line and Updates link open this site's log
    };
}

/**
 * openvibe-shared/shell (v2.10.0) loads footer.js but only boots the navbar: without this call the
 * server-rendered footer keeps its placeholder "shipped" line (shipped.js is loaded by footer.js's
 * init) and the client never re-renders with the site's links. Same options as the SSR footer, so it
 * rebuilds the same DOM; footer.js is deferred, so it has run by DOMContentLoaded when this fires.
 */
function footerBootScript(footer) {
    return `<script>window.addEventListener('DOMContentLoaded', function () { try { OpenVibeFooter.init(${jsonForScript(footerOptions(footer))}); } catch (e) { /* footer optional */ } });</script>`;
}

/**
 * The scripts that mount the navbar + footer, after the page content so a
 * slow Network never blocks the body. Used by the hand-written browse index
 * (server/public/browse.js); the shell pages get the same navbar options through
 * shell.page() plus footerBootScript() (the shell does not initialise the footer),
 * and the footer is rendered by frame.footer.
 */
function frameScripts({ history, footer } = {}) {
    const navOpts = navOptions({ history });
    const footOpts = footerOptions(footer);
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
 * A whole document, composed by openvibe-shared/shell: `seo` maps onto the shell's SEO options
 * (title, description, canonical, robots, image, og type, JSON-LD), `css` adds the page styles and
 * `body` is the <main> contents. The shell emits the theme-loader/web-runtime/navbar/footer scripts,
 * the no-JavaScript nav and the shared footer; `history` and `footer` become the navbar init options
 * and the server-rendered footer. The site's app icon, palette and Open Graph video tags ride in
 * through the shell's `head`.
 */
function page({ seo, css = '', body, history, footer }) {
    const html = shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: seo.title,
        siteName: SITE_NAME,
        description: seo.description,
        canonical: seo.canonical,
        image: seo.image || DEFAULT_OG_IMAGE,
        type: seo.ogType,
        robots: seo.robots || 'index, follow',
        jsonLd: seo.jsonLd,
        head: extraHead(seo, css) + footerBootScript(footer),
        body: `<div id="navbar-mount"></div>\n<main>\n${body}\n</main>`,
        navLinks: [{ label: 'Videos', href: '/?tab=videos' }, { label: 'Clips', href: '/?tab=clips' }],
        navbar: navOptions({ history }),
        footer: footerOptions(footer),
    });
    // The shell picks the card from whether a large image is present; a page can ask for the small
    // card explicitly (the account pages). seo.headTags has no override, so swap the one tag it
    // emitted after the fact.
    if (seo.twitterCard && seo.twitterCard !== 'summary_large_image') {
        return html.replace('<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:card" content="${esc(seo.twitterCard)}">`);
    }
    return html;
}

module.exports = {
    NETWORK_URL, SITE_NAME, DEFAULT_OG_IMAGE, APP_PUBLIC_URLS, appUrl,
    esc, abs, snip, isoDate, isoDuration, fmtDuration, fmtDate, jsonForScript,
    extraHead, baseCss, frameScripts, navOptions, footerOptions, defaultFooterLinks, page, DEFAULT_THEME_CSS,
};
