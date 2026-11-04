'use strict';
/**
 * D11: the view-hash salt copied into media_settings is blanked at boot once the sealed config store holds it.
 * The reader still gets it, a rotated salt goes through the write-only store path, and no summary or log carries
 * the plaintext.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/legacy-secrets-kek.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.OV_CONFIG_KEKS = `k1:${Buffer.alloc(32, 11).toString('base64')}`;
process.env.OV_CONFIG_KEK_CURRENT = 'k1';
delete process.env.VIEW_HASH_SECRET;
delete process.env.MEDIA_SECRET;

const SECRET = 'sentinel-not-a-secret-view-salt';
const logs = [];
const real = { log: console.log, warn: console.warn, error: console.error };
console.log = (...a) => logs.push(a.map(String).join(' '));
console.warn = (...a) => logs.push(a.map(String).join(' '));
console.error = (...a) => logs.push(a.map(String).join(' '));

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    await db.run("INSERT INTO media_settings (key, value, description, type) VALUES ('view_hash_secret', ?, 'salt', 'string')", [SECRET]);

    const siteConfig = require('../server/admin/site-config');
    const report = await siteConfig.init();
    const store = await siteConfig.getStore();
    assert.strictEqual(store.sealed, true, 'the store is sealed under the KEK');
    assert.strictEqual(report.blanked, 1);

    const row = await db.get('SELECT value FROM media_settings WHERE key = ?', ['view_hash_secret']);
    assert.strictEqual(row.value, '', 'no secret-class value remains in media_settings');
    assert.strictEqual(await siteConfig.secretValue(), SECRET, 'the store holds the salt');
    const views = require('../server/views/service');
    assert.strictEqual(await views.hashSecret(), SECRET, 'the view reader still gets its salt');

    const summary = JSON.stringify(await store.summary());
    assert.ok(!summary.includes(SECRET), 'the summary carries no value');
    const stored = await db.get("SELECT values_json FROM config_snapshots WHERE namespace = 'media.site_settings' AND state = 'active'");
    assert.ok(!stored.values_json.includes(SECRET), 'values_json holds no plaintext');
    assert.ok(stored.values_json.includes('\"v1:'), 'the secret is stored as an envelope');
    assert.ok(!logs.join('\n').includes(SECRET), 'no log line carries the value');

    await siteConfig.setSecret('sentinel-rotated', { reason: 'rotate' });
    assert.strictEqual((await db.get('SELECT value FROM media_settings WHERE key = ?', ['view_hash_secret'])).value, '', 'a rotated salt is not written to the legacy row');
    assert.strictEqual(await siteConfig.secretValue(), 'sentinel-rotated');

    real.log('legacy secrets (KEK): all checks passed');
    process.exit(0);
})().catch((err) => { real.error(err); process.exit(1); });
