'use strict';
// GET /limits.json (WS-N task 7): the developer limits Media enforces, read from the running config
// (an env override is what it answers), public with CORS *; Codes' /docs/limits renders it.
process.env.MEDIA_APP_SANDBOX_QUOTA_MB = '50';
const assert = require('assert');
const http = require('http');
const express = require('express');
const config = require('../server/config');
const { limitsOf, mountLimits } = require('../server/limits');

(async () => {
    const MB = 1024 * 1024;
    const by = Object.fromEntries(limitsOf(config).limits.map((l) => [l.id, l]));
    assert.deepStrictEqual([by.storage_bytes.production, by.storage_bytes.sandbox], [config.apps.projectQuotaMb * MB, 50 * MB], 'an env override is what it answers');
    assert.strictEqual(by.child_namespaces.production, config.objects.maxChildNamespaces);
    assert.strictEqual(by.storage_bytes.exceeded, '413 media.quota.exceeded');
    assert.strictEqual(by.deleted_retention_days.capability, 'media.object.delete');
    for (const l of Object.values(by)) assert.ok(Number.isInteger(l.production) && Number.isInteger(l.sandbox) && l.unit && l.exceeded, l.id);

    const app = express();
    mountLimits(app, config);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/limits.json`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual((await res.json()).service, 'media');
    server.close();
    console.log('limits: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
