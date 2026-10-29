'use strict';
// The Markdown twins of OpenVibe.Media's public pages (openvibe-shared/agent-layer): the media index (the home and
// /browse) and the watch page of a recording (/v/:id) or a clip (/c/:id).
//
// A twin is the page's own render: the public router answers the request in-process, signed out, so a twin cannot
// drift from the page a browser gets and never carries a signed-in person's view. A private item, a missing item and
// a virtual clip (which answers with its playlist, not a page) have no twin.
const TWIN_PATH_RE = /^\/(?:v\/[^/]+|c\/[^/]+|browse)?$/;

/** A request as an anonymous browser makes it: no session, no cookies. */
function anonymousRequest(path, query, host, app) {
    const search = query && query.toString() ? `?${query.toString()}` : '';
    const url = `${path}${search}`;
    return {
        method: 'GET', url, originalUrl: url, path, params: {}, query: query ? Object.fromEntries(query) : {},
        headers: { accept: 'text/html', host }, cookies: {}, body: undefined, protocol: 'https', secure: true,
        ip: '127.0.0.1', ips: ['127.0.0.1'], hostname: host,
        // The app the page router is mounted in: its locals (the context the pages read) and its settings.
        app,
        get(name) { return this.headers[String(name || '').toLowerCase()] || ''; },
        accepts(types) {
            if (!Array.isArray(types)) return 'text/html';
            return types.some((t) => t === 'html' || t === 'text/html') ? 'html' : false;
        },
        is() { return false; },
    };
}

/** A response that keeps what the page wrote, so the twin can be built from it. */
function captureResponse() {
    return {
        statusCode: 200, headers: {}, body: null, headersSent: false, locals: {},
        write(chunk) { this.body = (this.body || '') + String(chunk); return true; },
        writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
        sendStatus(code) { this.statusCode = code; this.body = ''; this.headersSent = true; return this; },
        status(code) { this.statusCode = code; return this; },
        // Header names are case-insensitive, as in Express: they are stored lowercase and read the same way.
        set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
        getHeader(name) { return this.headers[String(name).toLowerCase()]; },
        get(name) { return this.headers[String(name).toLowerCase()]; },
        removeHeader(name) { delete this.headers[String(name).toLowerCase()]; },
        type(value) { this.headers['content-type'] = value === 'html' ? 'text/html; charset=utf-8' : String(value); return this; },
        location(url) { this.headers.Location = url; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        json(body) { this.body = JSON.stringify(body); this.headersSent = true; return this; },
        redirect(code, url) { this.statusCode = code; this.headers.Location = url; this.body = ''; this.headersSent = true; return this; },
        end(body) { if (body !== undefined) this.body = body; this.headersSent = true; return this; },
        cookie() { return this; }, clearCookie() { return this; },
    };
}

function createAgentPages({ router, host, app }) {
    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!TWIN_PATH_RE.test(p)) return null;
        const req = anonymousRequest(p, query, host, app);
        const res = captureResponse();
        req.res = res;
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            const send = res.send.bind(res);
            res.send = (body) => { send(body); finish(); return res; };
            const json = res.json.bind(res);
            res.json = (body) => { json(body); finish(); return res; };
            const redirect = res.redirect.bind(res);
            res.redirect = (code, url) => { redirect(code, url); finish(); return res; };
            const end = res.end.bind(res);
            res.end = (body) => { end(body); finish(); return res; };
            try { router(req, res, () => finish()); } catch { finish(); }
            const timer = setTimeout(finish, 10000);
            if (timer.unref) timer.unref();
        });
        // A private item answers 404 JSON, a virtual clip redirects to its playlist; neither has a page or a twin.
        if (res.statusCode !== 200 || res.body == null) return null;
        const html = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
        const type = String(res.headers['content-type'] || res.headers['Content-Type'] || '');
        // A page that wrote no content type is HTML when it wrote markup; anything else is not a page.
        if (!/^text\/html/i.test(type) && !(type === '' && /^\s*</.test(html))) return null;
        return { html };
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, TWIN_PATH_RE };
