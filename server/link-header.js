'use strict';
// The Link: header for a page's Markdown twin and llms.txt (SEO-24). A page names both in its head
// (<link rel="alternate" type="text/markdown"> and <link rel="describedby">, openvibe-shared/agent-layer); this says
// the same in the header, for a reader that fetches only the headers or reads them first. It copies what the head
// says, so the two never disagree, and a page whose head names no twin (signed in, not found) sends no header.

const LINK_TAG = /<link\b[^>]*>/gi;
const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return m ? (m[1] != null ? m[1] : m[2]) : null;
};
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// URL encoding keeps a page's address out of HTTP header syntax (the same as linkHeaderTags).
const headerUrl = (s) => String(s).replace(/[<>"\r\n]/g, (c) => encodeURIComponent(c));

/** The Link header value an HTML page's head implies, or null when its head names no twin and no llms.txt. */
function linksOf(html) {
    const end = String(html).search(/<\/head>/i);
    if (end < 0) return null;
    let twin = null;
    let llms = null;
    for (const tag of String(html).slice(0, end).match(LINK_TAG) || []) {
        const rel = String(attr(tag, 'rel') || '').toLowerCase().split(/\s+/);
        const href = attr(tag, 'href');
        if (!href) continue;
        if (!twin && rel.includes('alternate') && String(attr(tag, 'type') || '').toLowerCase() === 'text/markdown') twin = unescape(href);
        else if (!llms && rel.includes('describedby')) llms = unescape(href);
    }
    if (!twin || !llms) return null;
    return `<${headerUrl(twin)}>; rel="alternate"; type="text/markdown", <${headerUrl(llms)}>; rel="describedby"`;
}

/** Express middleware, mounted before the page routes: a successful HTML page sends the header its head implies. */
function linkHeader() {
    return function pageLinkHeader(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const send = res.send;
        res.send = function sendWithLinkHeader(body) {
            if (typeof body === 'string' && res.statusCode >= 200 && res.statusCode < 300 && !res.get('Link')
                && /^text\/html\b/i.test(String(res.get('Content-Type') || 'text/html'))) {
                const value = linksOf(body);
                if (value) res.set('Link', value);
            }
            return send.call(this, body);
        };
        next();
    };
}

module.exports = { linkHeader, linksOf };
