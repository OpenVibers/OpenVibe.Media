'use strict';
/**
 * The answer for a path nothing matched: Express's own 404 page ("Cannot GET /x", default-src 'none'),
 * plus Cloudflare Web Analytics. Cloudflare injects its beacon into every HTML answer at the edge, and
 * the network's privacy text says Cloudflare may measure performance; under Express's default policy the
 * beacon was blocked and logged a CSP error on every not-found page (browser check, OpenVibe.Host
 * scripts/browser-check.js). Media's pages send no policy of their own, so this is Media's one CSP.
 */
const CSP = [
    "default-src 'none'",
    // Cloudflare Web Analytics: script-src loads the beacon, connect-src is where it reports.
    'script-src https://static.cloudflareinsights.com',
    'connect-src https://cloudflareinsights.com',
].join('; ');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function notFound(req, res) {
    res.status(404);
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot ${esc(req.method)} ${esc(req.originalUrl)}</pre>
</body>
</html>
`);
}

module.exports = { notFound, CSP };
