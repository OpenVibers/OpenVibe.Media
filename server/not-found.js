'use strict';
/**
 * The answer for a path nothing matched. A browser that asks for a page gets Media's own 404 page in the
 * OpenVibe Frame (server/public/page-frame.js); an API client, a player, or a client that does not accept
 * HTML keeps the JSON answer. The page never names the path or method that was asked for.
 *
 * Cloudflare Web Analytics is allowed by this page's CSP: Cloudflare injects its beacon into every HTML
 * answer at the edge, and the network's privacy text says it may measure performance. Media's other pages
 * send no policy of their own, so this is the one place the beacon's sources are listed.
 */
const pageFrame = require('./public/page-frame');
const config = require('./config');

const CSP = [
    "default-src 'self'",
    // The Frame's theme-loader, navbar and footer are served from /shared; the inline boot and page style are the shell's.
    "script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://openvibe.network https://cloudflareinsights.com",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

let cached = null;
function page() {
    if (cached) return cached;
    const host = String(config.publicUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const home = pageFrame.esc(config.publicUrl);
    cached = pageFrame.page({
        seo: {
            title: 'Page not found · OpenVibe.Media',
            description: `There is no page at this address on ${host}.`,
            robots: 'noindex, follow',
            ogType: 'website',
        },
        body: `<h1>Page not found</h1>
<p class="note">There is no page at this address on ${pageFrame.esc(host)}. The link may be old or mistyped.</p>
<div class="actions">
<a class="btn" href="${home}/">OpenVibe.Media home</a>
<a class="btn ghost" href="${home}/?tab=videos">Videos</a>
<a class="btn ghost" href="${home}/?tab=clips">Clips</a>
</div>`,
        footer: { variant: 'compact' },
    });
    return cached;
}

function notFound(req, res) {
    res.status(404);
    res.set('X-Content-Type-Options', 'nosniff');
    // An API caller gets JSON, as from Media's own API routes; so does a player or a client that does not want a page.
    if (req.path === '/api' || req.path.startsWith('/api/')
        || req.method !== 'GET' || req.accepts(['application/json', 'text/html']) !== 'text/html') {
        return res.json({ error: 'Not found' });
    }
    res.set('Content-Security-Policy', CSP);
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    return res.type('html').send(page());
}

module.exports = { notFound, CSP };
