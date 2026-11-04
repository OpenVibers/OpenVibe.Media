'use strict';
/**
 * Media's secret site settings in the revisioned configuration store (D11).
 *
 * `media_settings` keeps non-secret settings (storage_tier.*, view cooldowns, job cursors). A secret-class
 * value copied into it — today the view-hash salt `view_hash_secret` — is moved into the namespace
 * `media.site_settings`, where openvibe-shared/config seals it when the service has a KEK. The legacy row is
 * blanked at boot only after the sealed store holds it; without a KEK nothing is blanked and the store reports
 * sealed:false. Readers go through secretValue() (server/views/service.js) instead of the row.
 */
const config = require('openvibe-shared/config');
const db = require('../db/database');

const SECRET = /(api[_-]?key|secret|token|password|private[_-]?key|salt|access[_-]?key|webhook)/i;
const KEY = 'view_hash_secret';
const SYSTEM = { type: 'service', id: 'media' };

const isConfigKey = (key) => key === KEY;
const classify = (key) => (SECRET.test(key) ? 'secret' : 'internal');

let store = null;
function getStore() {
    if (store) return store;
    store = (async () => {
        const rows = await db.all('SELECT key, value FROM media_settings WHERE key = ?', [KEY]);
        const legacy = {};
        for (const r of rows) if (isConfigKey(r.key)) legacy[r.key] = r.value == null ? '' : String(r.value);
        return await config.createConfigStore({
            db: db.getDb(), service: 'media', namespace: 'media.site_settings',
            classify,
            legacy: () => legacy,
            // Nothing non-secret lives in this namespace; a secret is never mirrored into media_settings.
            onActivate: async () => {},
            log: { info: (m) => console.log(`[Config] ${m}`), warn: (m) => console.warn(`[Config] ${m}`), error: (m) => console.error(`[Config] ${m}`) },
        });
    })();
    return store;
}

function hasStore() { return store !== null; }
async function secretValue(key = KEY) {
    if (!store) return undefined;
    return (await store).get(key);
}

/** Generate the persisting salt through the write-only secret path; an explicit value never touches the row. */
async function setSecret(value, { reason = 'set view hash salt' } = {}) {
    return (await getStore()).setSecret(KEY, value, { actor: SYSTEM, reason });
}

/**
 * D11: blank the legacy row once the sealed store holds a readable, matching copy. Without a KEK (not sealed)
 * nothing is blanked; without a store value or with a locked envelope the row is kept. Counts only.
 */
async function migrateLegacySecrets(s) {
    const row = await db.get('SELECT value FROM media_settings WHERE key = ?', [KEY]);
    if (!row || row.value == null || String(row.value) === '') return { checked: 0, blanked: 0, differs: 0, kept: 0, sealed: !!s.sealed };
    if (!s.sealed) {
        console.log('[Config] legacy media_settings: 1 secret value left (no KEK; the store is not sealed)');
        return { checked: 1, blanked: 0, differs: 0, kept: 1, sealed: false };
    }
    const summary = await s.summary();
    const snap = summary.active;
    const stored = s.get(KEY);
    const marker = summary.secrets[KEY] || (typeof s.secretMarker === 'function' ? await s.secretMarker(KEY) : null);
    const sealedRow = snap && snap.values ? snap.values[KEY] : null;
    const proven = stored !== undefined && stored !== null && String(stored) !== ''
        && marker && sealedRow && sealedRow.redacted === true
        && marker.fingerprint && marker.fingerprint === sealedRow.fingerprint;
    // Never drop a value the store does not hold: the sealed copy must be exactly this legacy value.
    if (!proven || String(stored) !== String(row.value)) {
        console.log('[Config] legacy media_settings: 1 secret value kept (value differs or no sealed copy)');
        return { checked: 1, blanked: 0, differs: 1, kept: 1, sealed: true };
    }
    await db.run('UPDATE media_settings SET value = ?, updated_at = ov_now() WHERE key = ?', ['', KEY]);
    console.log(`[Config] legacy media_settings: 1 secret value blanked (the store holds the same value); KEK ${s.kek}`);
    return { checked: 1, blanked: 1, differs: 0, kept: 0, sealed: true };
}

let initPromise = null;
/** Boot: load the store, seal old plaintext rows, then blank the legacy copy the sealed store holds. */
function init({ adopt = true } = {}) {
    if (initPromise) return initPromise;
    if (!adopt) {
        // A restore drill never writes (MEDIA_DRILL): load nothing here; its readers fall back without persisting.
        return Promise.resolve({ loaded: false, checked: 0, blanked: 0, differs: 0, kept: 0, sealed: false });
    }
    initPromise = (async () => {
        const s = await getStore();
        if (s.sealed) await s.reseal();
        return { loaded: true, ...(await migrateLegacySecrets(s)) };
    })().catch((err) => { initPromise = null; throw err; });
    return initPromise;
}

module.exports = { KEY, getStore, init, hasStore, secretValue, setSecret, migrateLegacySecrets, isConfigKey, classify, _reset: () => { store = null; initPromise = null; } };
