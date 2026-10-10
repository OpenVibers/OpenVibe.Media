'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');

(async () => {
    const db = require('../server/db/database');
    await db.upsertApp({ app_id: 'live', name: 'OpenVibe.Live', api_key: 'live-key' });
    const ids = [
        'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3',
        'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4',
        'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2C5',
    ];
    for (const [i, kind, slug, visibility] of [[0, 'screenshot', 'old-shot', 'public'], [1, 'avatar', 'old-avatar', 'unlisted'], [2, 'screenshot', 'private-shot', 'private']]) {
        await db.run('INSERT INTO media_objects (id, app_id, namespace, kind, visibility, lifecycle_status, legacy_ref) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [ids[i], 'live', 'live', kind, visibility, 'ready', `legacy:live:${kind === 'avatar' ? 'avatar' : 'paste'}:${slug}`]);
    }
    const app = express();
    app.use(require('../server/public/routes'));
    const server = http.createServer(app);
    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const config = require('../server/config');
        for (const [slug, target] of [
            ['old-shot', `/o/${ids[0]}`],
            ['old-avatar', `/o/${ids[1]}`],
            ['private-shot', `${config.pastes.movedTo}/p/private-shot/screenshot`],
            ['unknown-shot', `${config.pastes.movedTo}/p/unknown-shot/screenshot`],
        ]) {
            const response = await fetch(`${base}/p/${slug}/screenshot`, { redirect: 'manual' });
            assert.deepStrictEqual([response.status, response.headers.get('location')], [301, target], slug);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    console.log('paste screenshot redirect: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
