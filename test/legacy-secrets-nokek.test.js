'use strict';
/**
 * D11: without a KEK the config store is not sealed and nothing in media_settings is blanked. The reader still
 * gets the salt (the store holds it, as before).
 *
 *   node --import ./test/helpers/pg-preload.mjs test/legacy-secrets-nokek.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
delete process.env.OV_CONFIG_KEKS;
delete process.env.OV_CONFIG_KEK_CURRENT;
delete process.env.VIEW_HASH_SECRET;
delete process.env.MEDIA_SECRET;

const SECRET = 'sentinel-not-a-secret-no-kek';
const real = { log: console.log, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    await db.run("INSERT INTO media_settings (key, value, description, type) VALUES ('view_hash_secret', ?, 'salt', 'string')", [SECRET]);

    const siteConfig = require('../server/admin/site-config');
    const report = await siteConfig.init();
    const store = await siteConfig.getStore();
    assert.strictEqual(store.sealed, false);
    assert.strictEqual(report.blanked, 0, 'nothing is blanked without a sealed store');
    assert.strictEqual((await db.get('SELECT value FROM media_settings WHERE key = ?', ['view_hash_secret'])).value, SECRET, 'the only copy is still the legacy row');
    assert.strictEqual(await siteConfig.secretValue(), SECRET);
    assert.strictEqual(await require('../server/views/service').hashSecret(), SECRET);

    real.log('legacy secrets (no KEK): all checks passed');
    process.exit(0);
})().catch((err) => { real.error(err); process.exit(1); });
