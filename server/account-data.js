'use strict';
/**
 * Account export and deletion → Media (roadmap WS-B task 7, ADR-033; Contracts 0.71.0). Both arrive at
 * POST /internal/events (server/revocations.js), signed and loopback-only, once per export or deletion
 * (account_data_events); the delivery is answered after Network took the part or the confirmation, so a failure is
 * redelivered without erasing twice.
 *
 *   network.account.export_requested  Media's part (POST /internal/account-exports/:id/parts with a service token):
 *                                     objects.json (every media object the subject owns, with its public URL while
 *                                     it has one), vods.json and clips.json (their rows, stream keys and storage keys
 *                                     left out). The bytes are downloaded from the URLs.
 *   network.account.deleted           what the subject (and the accounts merged into it) own goes:
 *                                     - native objects are soft-deleted; their bytes are purged after the retention
 *                                       days, as for any deletion;
 *                                     - VODs, clips and files are removed like their delete routes do (the bytes
 *                                       everywhere, the row, and the object through the row-delete trigger);
 *                                     - the thumbnails of those VODs and clips are marked deleted.
 *                                     Media under a retention hold (ADR-006) is kept and counted.
 *                                     Media then confirms with counts (POST /internal/account-deletions/:id/confirmations).
 */
const fs = require('fs');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXPORT_RE = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELETION_RE = /^del_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOPICS = ['network.account.export_requested', 'network.account.deleted'];
const SECRET_COL = /(^|_)(token|secret|hash|password|key|keys|stream_key|storage_key)($|_)/i;
const ROW_LIMIT = 5000;


const clean = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) if (!SECRET_COL.test(k)) o[k] = v; return o; };
const inList = (xs) => `(${xs.map(() => '?').join(',')})`;

async function exportPart(db, subjects) {
    const model = require('./objects/model');
    const objs = await db.prepare(`SELECT * FROM media_objects WHERE owner_subject IN ${inList(subjects)} AND lifecycle_status != 'deleted' ORDER BY created_at DESC LIMIT ${ROW_LIMIT}`).all(...subjects);
    const objects = (await Promise.all(objs.map(async (o) => {
        const p = await model.objectPublic(o, { locations: false });
        return { id: p.id, kind: p.kind, visibility: p.visibility, lifecycle_status: p.lifecycle_status, mime_type: p.mime_type, size_bytes: p.size_bytes,
            public_url: p.public_url, legacy_ref: p.legacy_ref, created_at: p.created_at, held: p.held };
    })));
    const ids = objs.map((o) => o.id);
    const rows = async (table) => (ids.length ? (await db.prepare(`SELECT * FROM ${table} WHERE object_id IN ${inList(ids)} ORDER BY created_at DESC`).all(...ids)).map(clean) : []);
    const files = [{ name: 'objects.json', content: objects }];
    const vods = await rows('vods'); const clips = await rows('clips'); const plain = await rows('files');
    if (vods.length) files.push({ name: 'vods.json', content: vods });
    if (clips.length) files.push({ name: 'clips.json', content: clips });
    if (plain.length) files.push({ name: 'files.json', content: plain });
    return { files, truncated: objs.length >= ROW_LIMIT ? ['objects.json'] : [], note: 'Download each file from its public_url; private ones from openvibe.media while signed in.' };
}

/** Erase what the subjects own → { erased, retained }. Each object in its own step: a hold stops only that one. */
async function erase(db, subjects) {
    const model = require('./objects/model');
    const erased = {};
    const retained = {};
    const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
    const objs = await db.prepare(`SELECT * FROM media_objects WHERE owner_subject IN ${inList(subjects)} AND lifecycle_status != 'deleted' ORDER BY (kind = 'thumbnail'), created_at`).all(...subjects);
    for (const o of objs) {
        if (await model.isHeld(o.id)) { bump(retained, 'held_media'); continue; }
        try {
            if (!o.legacy_ref) { await model.softDelete(o, { by: 'account_deleted' }); bump(erased, 'objects'); continue; }
            if (o.kind === 'vod') {
                const vod = await db.prepare('SELECT * FROM vods WHERE object_id = ?').get(o.id);
                if (!vod) continue;
                if (vod.file_path) {
                    require('./vod/vod-storage').deleteVodObjects(vod).catch((e) => console.warn(`[AccountData] VOD ${vod.id} remote cleanup:`, e.message));
                    for (const p of [vod.file_path, vod.master_file_path]) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* gone */ } }
                }
                await db.prepare('DELETE FROM vods WHERE id = ?').run(vod.id);
                bump(erased, 'vods');
            } else if (o.kind === 'clip') {
                const clip = await db.prepare('SELECT * FROM clips WHERE object_id = ?').get(o.id);
                if (!clip) continue;
                try { if (clip.file_path && fs.existsSync(clip.file_path)) fs.unlinkSync(clip.file_path); } catch { /* gone */ }
                if (clip.storage_provider && clip.storage_provider !== 'local' && clip.storage_key) {
                    require('./vod/vod-storage').deleteVodObjects(clip).catch((e) => console.warn(`[AccountData] clip ${clip.id} remote cleanup:`, e.message));
                }
                await db.prepare('DELETE FROM clips WHERE id = ?').run(clip.id);
                bump(erased, 'clips');
            } else if (o.kind === 'file') {
                const row = await db.prepare('SELECT * FROM files WHERE object_id = ?').get(o.id);
                if (!row) continue;
                try { const p = require('./files/routes').filePathForKey(row); if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* gone */ }
                await db.prepare('DELETE FROM files WHERE key = ?').run(row.key);
                bump(erased, 'files');
            } else if (o.kind === 'thumbnail') {
                await db.prepare("UPDATE media_objects SET lifecycle_status = 'deleted', deleted_at = COALESCE(deleted_at, ov_now()), updated_at = ov_now() WHERE id = ? AND lifecycle_status != 'deleted'").run(o.id);
                bump(erased, 'thumbnails');
            } else {
                await model.softDelete(o, { by: 'account_deleted' });
                bump(erased, 'objects');
            }
        } catch (e) {
            if (/retention hold/.test(e.message)) { bump(retained, 'held_media'); continue; }
            throw e;
        }
    }
    try { require('./events').kick(); } catch { /* the relay polls anyway */ }
    return { erased, retained };
}

async function networkCall(path, body) {
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const base = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    if (!networkCall.tokens) {
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        networkCall.tokens = createServiceTokenClient({ tokenUrl: `${base}/oauth/token`, clientId: process.env.OV_OAUTH_CLIENT_ID || 'media', clientSecret });
    }
    const token = await networkCall.tokens.getToken({ audience: 'openvibe.network', scope: path.includes('/account-exports/') ? 'network.account.export.contribute' : 'network.account.deletion.confirm' });
    return fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
}

/** One envelope → 'exported' | 'erased' | 'confirmed' | 'closed' | 'unchanged' | 'ignored:<why>'; throws to be redelivered. */
async function apply(ev, { db = require('./db/database').getDb(), send = networkCall } = {}) {
    if (!ev || !TOPICS.includes(ev.event_type)) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (ev.event_type === 'network.account.export_requested') {
        if (!EXPORT_RE.test(String(p.export_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        const seen = await db.prepare('SELECT sent_at FROM account_data_events WHERE id = ?').get(p.export_id);
        if (seen && seen.sent_at) return 'unchanged';
        const part = await exportPart(db, [p.subject]);
        const res = await send(`/internal/account-exports/${p.export_id}/parts`, { subject: p.subject, ...part });
        const outcome = res.ok ? 'exported' : (res.status === 409 || res.status === 404 ? 'closed' : null);
        if (!outcome) throw new Error(`export part refused: ${res.status}`);
        await db.prepare(`INSERT INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, subject = excluded.subject, outcome = excluded.outcome, sent_at = excluded.sent_at, applied_at = ov_now_iso()`)
            .run(p.export_id, 'export', p.subject, JSON.stringify({ result: outcome, objects: part.files[0].content.length }), new Date().toISOString());
        return outcome;
    }
    if (!DELETION_RE.test(String(p.deletion_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
    let rec = await db.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
    let result = 'confirmed';
    if (!rec) {
        const subjects = [p.subject, ...(Array.isArray(p.aliases) ? p.aliases.filter((s) => SUBJECT_RE.test(String(s))) : [])];
        const counts = await erase(db, subjects);
        await db.prepare('INSERT INTO account_data_events (id, kind, subject, outcome) VALUES (?, ?, ?, ?)').run(p.deletion_id, 'deletion', p.subject, JSON.stringify(counts));
        console.log(`[AccountData] deletion ${p.deletion_id}: ${JSON.stringify(counts)}`);
        rec = await db.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
        result = 'erased';
    }
    if (rec.sent_at) return 'unchanged';
    const o = JSON.parse(rec.outcome || '{}');
    const res = await send(`/internal/account-deletions/${p.deletion_id}/confirmations`, { subject: p.subject, completed_at: rec.applied_at, erased: o.erased || {}, retained: o.retained || {} });
    if (!res.ok && res.status !== 404) throw new Error(`confirmation refused: ${res.status}`);
    await db.prepare('UPDATE account_data_events SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), p.deletion_id);
    return result;
}

module.exports = { apply, exportPart, erase, TOPICS };
