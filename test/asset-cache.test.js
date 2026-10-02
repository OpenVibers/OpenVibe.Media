'use strict';
// The cache policy comes from openvibe-shared/cache-policy (plan T11, lane D): a content-addressed
// asset is immutable for a year, everything else is a short public window with a long
// stale-while-revalidate. /me/app.js is the one setHeaders site that decides by the ?v= it was handed
// (server/me/routes.js): the layout's asset version gets the year, anything else the five minutes.
const assert = require('assert');
const express = require('express');
const cache = require('openvibe-shared/cache-policy');

(async () => {
    const pages = require('../server/me/pages');
    const { createMeRoutes } = require('../server/me/routes');

    const app = express();
    app.use('/me', createMeRoutes({ auth: { verify: async () => null } }).pages);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const fetchApp = async (v) => {
        const qs = v === undefined ? '' : `?v=${v}`;
        const r = await fetch(`http://127.0.0.1:${server.address().port}/me/app.js${qs}`);
        return { status: r.status, cache: r.headers.get('cache-control') };
    };

    try {
        // The layout asks for the exact asset version it rendered: content-addressed, immutable.
        const pinned = await fetchApp(pages.CLIENT_VERSION);
        assert.strictEqual(pinned.status, 200);
        assert.strictEqual(pinned.cache, 'public, max-age=31536000, immutable');
        assert.strictEqual(pinned.cache, cache.IMMUTABLE);

        // A wrong-but-hex ?v= and no ?v= at all are not content-addressed: five minutes plus a day of swr.
        for (const v of ['deadbeefdeadbeef', undefined]) {
            const r = await fetchApp(v);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.cache, 'public, max-age=300, stale-while-revalidate=86400');
            assert.strictEqual(r.cache, cache.assetHeaders('app.js', { hashed: false }));
        }
        console.log('asset-cache: ?v=<version> is immutable for a year; a wrong or missing ?v= is 5 min + a day of swr');
    } finally { server.close(); }
})().catch((err) => { console.error(err); process.exit(1); });
