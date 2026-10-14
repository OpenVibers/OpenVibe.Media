'use strict';
/**
 * S3 access keys (ADR-031): an `ovk_<ULID>` id and a secret, bound to one project environment, read and/or write,
 * and optionally to some of its zones. Media verifies SigV4 itself (server/s3/sigv4.js), so Media keeps the secret,
 * encrypted with MEDIA_S3_KEY_SECRET (AES-256-GCM); it is returned once, when the key is issued, and never again.
 *
 *   issue({ projectId, env, name, permissions, zones, createdBy }) → { key, secret }
 *   find(id)                → the row with `secret` (decrypted), or null; revoked keys are null too
 *   list(projectId)         → public shapes, newest first (revoked included)
 *   revoke(projectId, id, by) → the public shape, or null when there is no such key of that project
 *   publicShape(row)        → media.access-key@1
 *   enabled()               → whether keys can be issued and verified (the secret is configured)
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const db = require('../db/database');

const PERMISSIONS = ['read', 'write', 'read-write'];
const ZONE_ID_RE = /^zon_[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY_ID_RE = /^ovk_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_KEYS_PER_ENV = 50;
const TOUCH_MS = 60_000;

function masterKey() {
    const s = String(process.env.MEDIA_S3_KEY_SECRET || '');
    return s.length >= 32 ? crypto.createHash('sha256').update(s).digest() : null;
}
const enabled = () => !!masterKey();

function encrypt(secret) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

function decrypt(blob) {
    const [iv, tag, enc] = String(blob).split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const parseZones = (z) => (Array.isArray(z) ? z : (() => { try { return JSON.parse(z || '[]'); } catch { return []; } })());

function publicShape(r) {
    return {
        id: r.id,
        project_id: r.project_id,
        env: r.env,
        name: r.name,
        permissions: r.permissions,
        zones: parseZones(r.zones),
        created_by: r.created_by,
        created_at: iso(r.created_at),
        last_used_at: iso(r.last_used_at),
        revoked_at: iso(r.revoked_at),
    };
}

class KeyError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function issue({ projectId, env, name, permissions = 'read-write', zones = [], createdBy, now = Date.now() }) {
    if (!enabled()) throw new KeyError(503, 'media.s3.disabled', 'S3 access keys are not configured on this Media (MEDIA_S3_KEY_SECRET)');
    if (!['sandbox', 'production'].includes(env)) throw new KeyError(400, 'media.access_key.invalid', 'env is sandbox or production');
    if (!PERMISSIONS.includes(permissions)) throw new KeyError(400, 'media.access_key.invalid', `permissions is one of ${PERMISSIONS.join(', ')}`);
    const label = String(name || '').trim().slice(0, 80);
    if (!label) throw new KeyError(400, 'media.access_key.invalid', 'a key needs a name (what uses it)');
    if (!Array.isArray(zones) || zones.length > 20 || !zones.every((z) => ZONE_ID_RE.test(String(z)))) {
        throw new KeyError(400, 'media.access_key.invalid', 'zones is a list of at most 20 zone ids (zon_…); empty means every zone of the environment');
    }
    const uniq = [...new Set(zones)];
    for (const z of uniq) {
        const zone = await db.get('SELECT project_id, env, state FROM media_zones WHERE id = ?', [z]);
        if (!zone || zone.project_id !== projectId || zone.env !== env || !['provisioning', 'active'].includes(zone.state)) {
            throw new KeyError(404, 'media.access_key.unknown_zone', `${z} is not a zone of this project's ${env} environment`);
        }
    }
    const live = (await db.get('SELECT COUNT(*) AS n FROM media_access_keys WHERE project_id = ? AND env = ? AND revoked_at IS NULL', [projectId, env])).n;
    if (Number(live) >= MAX_KEYS_PER_ENV) throw new KeyError(409, 'media.access_key.limit', `an environment holds at most ${MAX_KEYS_PER_ENV} live keys; revoke one first`);
    const id = `ovk_${ids.ulid(now)}`;
    const secret = crypto.randomBytes(30).toString('base64url');           // 40 characters, as S3 secrets are
    await db.run(`INSERT INTO media_access_keys (id, project_id, env, name, permissions, zones, secret_enc, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, projectId, env, label, permissions, JSON.stringify(uniq), encrypt(secret), createdBy, now]);
    return { key: publicShape(await db.get('SELECT * FROM media_access_keys WHERE id = ?', [id])), secret };
}

const touched = new Map();
async function find(id, { now = Date.now() } = {}) {
    if (!KEY_ID_RE.test(String(id || '')) || !enabled()) return null;
    const row = await db.get('SELECT * FROM media_access_keys WHERE id = ? AND revoked_at IS NULL', [id]);
    if (!row) return null;
    let secret;
    try { secret = decrypt(row.secret_enc); } catch { return null; }      // a key encrypted under another secret
    if (!touched.has(id) || now - touched.get(id) > TOUCH_MS) {
        touched.set(id, now);
        await db.run('UPDATE media_access_keys SET last_used_at = ? WHERE id = ?', [now, id]);
    }
    return { ...row, zones: parseZones(row.zones), secret };
}

async function list(projectId) {
    const rows = await db.all('SELECT * FROM media_access_keys WHERE project_id = ? ORDER BY created_at DESC, id DESC', [projectId]);
    return rows.map(publicShape);
}

async function revoke(projectId, id, by, { now = Date.now() } = {}) {
    const row = await db.get('SELECT * FROM media_access_keys WHERE id = ? AND project_id = ?', [id, projectId]);
    if (!row) return null;
    if (row.revoked_at == null) await db.run('UPDATE media_access_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', [now, by, id]);
    touched.delete(id);
    return publicShape(await db.get('SELECT * FROM media_access_keys WHERE id = ?', [id]));
}

/** Revoke every live key scoped only to `zoneId` (a zone that was deleted); keys naming other zones lose it. */
async function dropZone(zoneId, { now = Date.now() } = {}) {
    const rows = await db.all("SELECT id, zones FROM media_access_keys WHERE revoked_at IS NULL AND zones::text LIKE ?", [`%${zoneId}%`]);
    for (const r of rows) {
        const rest = parseZones(r.zones).filter((z) => z !== zoneId);
        if (!rest.length) await db.run("UPDATE media_access_keys SET revoked_at = ?, revoked_by = 'system:zone-deleted' WHERE id = ?", [now, r.id]);
        else await db.run('UPDATE media_access_keys SET zones = ? WHERE id = ?', [JSON.stringify(rest), r.id]);
        touched.delete(r.id);
    }
    return rows.length;
}

module.exports = { issue, find, list, revoke, dropZone, publicShape, enabled, KeyError, PERMISSIONS, KEY_ID_RE, ZONE_ID_RE };
