'use strict';
/**
 * Sharing for Media's VODs and clips (design 2026-11-06, VISIBILITY-EVERYWHERE step 5; openvibe-sdk/share).
 *
 * The SDK owns the model and the rules: one `shares` row per VOD or clip, members, access requests,
 * transfers, the append-only log and the delivery queue. This file is the wiring Media supplies:
 *
 *   - network.json       Network's identity lookups (@name → subject, a person's card for the sheet)
 *   - events.publish     Media's Events outbox, so share.* envelopes go out with every other media event
 *   - notify             Network's notification push; a refusal is logged, never allowed to stall the queue
 *   - onAudienceChange   keeps vods/clips.visibility and is_public in step: public→public, link→unlisted,
 *                        people→private, private→private. The column fails closed for every old read path,
 *                        and the object projection and Search follow it.
 *
 * Media's column stays the fail-closed mirror. `people` is never stored there: it is a share.v1 audience,
 * and the watch page/bytes ask canView for it. A row that has no shares row yet (a legacy item, or one
 * created before the sheet first opened it) keeps its old column behaviour through `audienceOf`, and
 * `ensure()` registers it the first time its owner opens the sheet.
 */
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');
const contracts = require('openvibe-contracts');
const dbModule = require('./db/database');

const SERVICE = 'media';
const KINDS = ['vod', 'clip'];
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** Media's visibility words to the SDK's, and back. `people` has no column of its own. */
const TO_SDK = { public: 'public', unlisted: 'link', private: 'private' };
const FROM_SDK = { public: 'public', link: 'unlisted', people: 'private', private: 'private' };

const refOf = (kind, id) => ({ service: SERVICE, kind, id: String(id) });

/** Media's viewer as the SDK wants it: a canonical subject object. Never an app-local user id. */
function shareViewer(claims) {
    if (!claims) return null;
    const id = typeof claims.subject_id === 'string' ? claims.subject_id : null;
    if (!id || !/^(usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
    return { subject: { type: id.startsWith('gst_') ? 'guest' : 'user', id }, username: claims.username || null,
        staff: contracts.staff.can(claims, 'staff.moderation.chat') || contracts.staff.effectiveRole(claims) === 'owner' };
}

/** The owner of a row, as a canonical subject: the object's owner, else the service itself. */
function ownerOf(kind, row, object) {
    const subject = object && object.owner_subject;
    if (subject && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) return { type: 'user', id: subject };
    return { type: 'service', id: SERVICE };
}

function tableOf(kind) { return kind === 'vod' ? 'vods' : 'clips'; }
function columnOf(kind) { return kind === 'vod' ? 'vods' : 'clips'; }

function createSharing({ db = dbModule.getDb(), config = require('./config'), events = require('./events'),
    fetchImpl = globalThis.fetch, log = console, now = Date.now, networkJson: networkOverride = null } = {}) {
    const base = String(config.network.internalUrl || config.network.url || '').replace(/\/+$/, '');
    const tokens = !networkOverride && process.env.OV_OAUTH_CLIENT_SECRET
        ? serviceAuth.createTokenClient({
            tokenUrl: `${base}/oauth/token`,
            clientId: process.env.OV_OAUTH_CLIENT_ID || 'media',
            clientSecret: process.env.OV_OAUTH_CLIENT_SECRET,
            audience: 'openvibe.network',
            scope: 'identity.subject.resolve network.notifications.push',
            fetchImpl,
        }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (networkOverride) return await networkOverride({ path, method, json, query });
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification, addressed by canonical subject. It never carries a title or a description. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A recording was shared with you', 'Open it on OpenVibe.Media.'],
            'share.access_requested': ['Someone asked for access to your recording', 'Review the request on OpenVibe.Media.'],
            'share.transfer.requested': ['Someone wants to give you a recording', 'Accept or decline it on OpenVibe.Media.'],
            'share.transfer.answered': ['A recording transfer was answered', 'See what happened on OpenVibe.Media.'],
        }[n.kind] || ['Sharing on OpenVibe.Media', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: SERVICE, url: n.ref && n.ref.id ? `${config.publicUrl}/${n.ref.kind === 'clip' ? 'c' : 'v'}/${encodeURIComponent(n.ref.id)}` : config.publicUrl,
                    category: 'social',
                },
            });
        } catch (err) {
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    /** The row's audience change keeps the old column in step, then re-projects the object and Search. */
    async function onAudienceChange(ref, audience, tx) {
        if (ref.service !== SERVICE || !KINDS.includes(ref.kind)) return;
        const table = tableOf(ref.kind);
        const row = await tx.maybe(`SELECT id, app_id, visibility FROM ${table} WHERE id = $1`, [Number(ref.id)]);
        if (!row) return;
        const visibility = FROM_SDK[audience] || 'private';
        if (row.visibility !== visibility) {
            await tx.exec(`UPDATE ${table} SET visibility = $1, is_public = $2 WHERE id = $3`, [visibility, visibility === 'public' ? 1 : 0, row.id]);
        }
        const changed = row.visibility !== visibility;
        tx.afterCommit(async () => {
            if (changed) {
                const model = require('./objects/model');
                try {
                    // The object's visibility is the fail-closed mirror; re-project it and turn the staged
                    // change into media.object.visibility_changed (with the audience and members) in one
                    // transaction, so Live's Rundown hears about a `people` change as it happens.
                    await db.tx(async () => {
                        await (ref.kind === 'clip' ? model.syncClip(row.id) : model.syncVod(row.id));
                        await events.recordObjectChanges();
                    });
                    events.kick();
                } catch (err) { log.warn('[Sharing] object sync:', err.message); }
            }
            try { await require('./public/search-documents').syncOne(ref.kind, row.id); } catch (err) { log.warn('[Sharing] search sync:', err.message); }
        });
    }

    /** Ownership moved: the object carries the canonical owner (the row's app-local ids never change). */
    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || !KINDS.includes(ref.kind)) return;
        if (!to || to.type !== 'user') return;
        const row = await tx.maybe(`SELECT app_id FROM ${tableOf(ref.kind)} WHERE id = $1`, [Number(ref.id)]);
        if (!row) return;
        await tx.exec('UPDATE media_objects SET owner_subject = $1, updated_at = ov_now() WHERE legacy_ref = $2',
            [to.id, `legacy:${row.app_id}:${ref.kind}:${ref.id}`]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish: async (envelope) => await events.publish(envelope) },
        notify,
        onAudienceChange,
        onOwnerChange,
    });

    const rowOf = async (kind, id) => await db.maybe(`SELECT * FROM ${tableOf(kind)} WHERE id = $1`, [Number(id)]);

    /** The share row, or null. */
    async function shareOf(kind, id) {
        return await db.maybe(`SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3`, [SERVICE, kind, String(id)]);
    }

    /** Media's audience for a row: the share row when it exists, else the column's 1:1 mapping. */
    async function audienceOf(kind, id) {
        const share = await shareOf(kind, id);
        if (share && AUDIENCES.includes(share.audience)) return share.audience;
        const row = await rowOf(kind, id);
        if (!row) return 'private';
        const visibility = row.visibility || (row.is_public ? 'public' : 'private');
        return TO_SDK[visibility] || 'private';
    }

    /** The audience of every named row in one query. */
    async function audiencesOf(kind, ids) {
        const list = [...new Set(ids.map(Number).filter(Number.isSafeInteger))];
        if (!list.length) return new Map();
        const rows = await db.many(`SELECT resource_id, audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = ANY($3::text[])`,
            [SERVICE, kind, list.map(String)]);
        const found = new Map(rows.map((r) => [Number(r.resource_id), r.audience]));
        const missing = list.filter((id) => !found.has(id));
        if (missing.length) {
            const table = tableOf(kind);
            const cols = await db.many(`SELECT id, visibility, is_public FROM ${table} WHERE id = ANY($1::bigint[])`, [missing]);
            for (const r of cols) found.set(Number(r.id), TO_SDK[r.visibility || (r.is_public ? 'public' : 'private')] || 'private');
        }
        return found;
    }

    /** Register a row that has no share row yet (a legacy item, or one created before its owner opened the sheet). */
    async function ensure(kind, id) {
        if (!KINDS.includes(kind)) return null;
        const existing = await shareOf(kind, id);
        if (existing) return existing;
        const row = await rowOf(kind, id);
        if (!row) return null;
        const object = await db.maybe('SELECT owner_subject FROM media_objects WHERE legacy_ref = $1', [`legacy:${row.app_id}:${kind}:${id}`]);
        const visibility = row.visibility || (row.is_public ? 'public' : 'private');
        try {
            await shares.register(refOf(kind, id), { owner_subject: ownerOf(kind, row, object), audience: TO_SDK[visibility] || 'private' });
        } catch (err) {
            if (err.status !== 409) throw err;   // somebody registered it first: use theirs
        }
        return await shareOf(kind, id);
    }

    /** The owner's save from a create route: a new VOD/clip starts at its column's audience. */
    async function register(kind, id, visibility = 'private') {
        const row = await rowOf(kind, id);
        if (!row) return null;
        const object = await db.maybe('SELECT owner_subject FROM media_objects WHERE legacy_ref = $1', [`legacy:${row.app_id}:${kind}:${id}`]);
        try {
            return await shares.register(refOf(kind, id), { owner_subject: ownerOf(kind, row, object), audience: TO_SDK[visibility] || 'private' });
        } catch (err) {
            if (err.status === 409) return await shareOf(kind, id);
            throw err;
        }
    }

    /**
     * The write routes' visibility change keeps the share row in step (the sheet and the select never
     * disagree). A `people` row moved by the owning app becomes that app's new column audience.
     */
    async function syncAudience(kind, id, visibility) {
        const next = TO_SDK[visibility] || 'private';
        await db.tx(async (t) => {
            const row = await t.maybe(`SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3 FOR UPDATE`, [SERVICE, kind, String(id)]);
            if (!row || row.audience === next) return;
            await t.exec('UPDATE shares SET audience = $1, revision = revision + 1 WHERE service = $2 AND kind = $3 AND resource_id = $4', [next, SERVICE, kind, String(id)]);
        });
    }

        return {
        shares,
        SERVICE,
        KINDS,
        AUDIENCES,
        TO_SDK,
        FROM_SDK,
        refOf,
        shareViewer,
        shareOf,
        audienceOf,
        audiencesOf,
        ensure,
        register,
        syncAudience,
        canView: async (kind, id, claims) => await shares.canView(shareViewer(claims), refOf(kind, id)),
        canEdit: async (kind, id, claims) => await shares.canEdit(shareViewer(claims), refOf(kind, id)),
        get: async (kind, id, claims) => { await ensure(kind, id); return await shares.get(shareViewer(claims), refOf(kind, id)); },
        getWithRevision: async (kind, id, claims) => { await ensure(kind, id); return await shares.getWithRevision(shareViewer(claims), refOf(kind, id)); },
        update: async (kind, id, claims, body, opts) => { await ensure(kind, id); return await shares.update(shareViewer(claims), refOf(kind, id), body, opts); },
        addMembers: async (kind, id, claims, list) => { await ensure(kind, id); return await shares.addMembers(shareViewer(claims), refOf(kind, id), list); },
        removeMember: async (kind, id, claims, subject) => { await ensure(kind, id); return await shares.removeMember(shareViewer(claims), refOf(kind, id), subject); },
        requestAccess: async (kind, id, claims) => { await ensure(kind, id); return await shares.requestAccess(shareViewer(claims), refOf(kind, id)); },
        dismiss: async (kind, id, claims, requestId) => await shares.dismiss(shareViewer(claims), refOf(kind, id), requestId),
        transfer: async (kind, id, claims, input) => await shares.transfer(shareViewer(claims), refOf(kind, id), input),
        accept: async (kind, id, claims, transferId) => await shares.accept(shareViewer(claims), refOf(kind, id), transferId),
        decline: async (kind, id, claims, transferId) => await shares.decline(shareViewer(claims), refOf(kind, id), transferId),
        cancel: async (kind, id, claims, transferId) => await shares.cancel(shareViewer(claims), refOf(kind, id), transferId),
        lookup: async (claims, name) => await shares.lookup(shareViewer(claims), name),
        sharedWithMe: async (claims, opts) => await shares.sharedWithMe(shareViewer(claims), { service: SERVICE, ...(opts || {}) }),
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** The signed-in viewer's verified claims, or null. Never an app key, never an app-local user id. */
async function viewerClaims(req) {
    let token = null;
    try { token = require('./user-auth').extractToken(req); } catch { token = null; }
    if (!token) return null;
    try {
        const { verifyUserToken } = require('openvibe-sdk/auth');
        const auth = require('./auth');
        const claims = await verifyUserToken(String(token), { ...auth.networkKeys().verifyOptions, issuer: require('./config').network.url });
        if (!claims || require('./revocations').isRevoked(claims)) return null;
        return claims;
    } catch { return null; }
}

/** Express middleware: attach the verified viewer claims for the public watch page and the share API. */
async function attachViewer(req, _res, next) {
    req.shareClaims = await viewerClaims(req);
    next();
}

/** The uniform API's describe(ref): the sheet shows the VOD/clip's title and watch page to its owner. */
function describeRef(db) {
    return async (ref) => {
        if (ref.service !== SERVICE || !KINDS.includes(ref.kind)) return {};
        const table = tableOf(ref.kind);
        const row = await db.maybe(`SELECT id, app_id, title, visibility, is_public FROM ${table} WHERE id = $1`, [Number(ref.id)]);
        if (!row) return {};
        const audience = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, ref.kind, String(ref.id)]);
        const mapped = audience ? audience.audience : (TO_SDK[row.visibility || (row.is_public ? 'public' : 'private')] || 'private');
        return {
            title: row.title || (ref.kind === 'vod' ? `VOD #${row.id}` : `Clip #${row.id}`),
            link: `${String(require('./config').publicUrl || '').replace(/\/+$/, '')}/${ref.kind === 'clip' ? 'c' : 'v'}/${row.id}`,
            roles: ['viewer'],
            audiences: AUDIENCES,
            transferable: true,
            audience: mapped,
        };
    };
}

module.exports = { createSharing, describeRef, shareViewer, viewerClaims, attachViewer, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KINDS };
