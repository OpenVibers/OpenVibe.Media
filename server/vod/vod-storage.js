/**
 * OpenVibe.Media — VOD Storage Engine (local / Backblaze B2 / Cloudflare R2)
 *
 * Ported from the predecessor's object-storage tier manager:
 *
 *   local — ./data/vods            recordings + recent VODs (fast, limited)
 *   b2    — Backblaze B2 bucket    canonical cold tier: unpopular VODs are
 *                                  uploaded here and deleted locally
 *   r2    — Cloudflare R2 bucket   popularity cache: high-traffic VODs get a
 *                                  copy here (free egress) and play from R2
 *
 * Invariants:
 *   - vods.storage_provider ∈ ('local','b2','r2') = where playback comes from
 *   - every offloaded VOD has a canonical B2 object at vods/<basename>
 *   - provider 'r2' implies the B2 canonical object also exists; demoting
 *     from R2 just deletes the R2 copy and flips back to 'b2'
 *
 * Playback for b2/r2 is a 302 redirect to a presigned GET URL (range
 * requests are handled by the object store; R2 egress is free, B2 gives
 * 3x stored volume per day free).
 *
 * The periodic sweep:
 *   1. offloads unpopular local VODs to B2 (age + views + last access);
 *      under disk pressure it drains oldest/least-watched VODs down to a
 *      low-water mark regardless of the popularity thresholds
 *   2. promotes popular VODs to R2
 *   3. demotes stale R2 VODs back to B2-only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config');
const db = require('../db/database');

let S3;         // @aws-sdk/client-s3 (lazy)
let LibStorage; // @aws-sdk/lib-storage (lazy)
let Presigner;  // @aws-sdk/s3-request-presigner (lazy)
function loadSdk() {
    if (!S3) {
        S3 = require('@aws-sdk/client-s3');
        LibStorage = require('@aws-sdk/lib-storage');
        Presigner = require('@aws-sdk/s3-request-presigner');
    }
}

// ── Provider configuration (env) ─────────────────────────────
const PROVIDER_ENV = {
    b2: {
        endpoint: process.env.MEDIA_B2_ENDPOINT || '',
        region: process.env.MEDIA_B2_REGION || 'us-west-004',
        bucket: process.env.MEDIA_B2_BUCKET || '',
        accessKeyId: process.env.MEDIA_B2_KEY_ID || '',
        secretAccessKey: process.env.MEDIA_B2_APP_KEY || '',
        forcePathStyle: true,
    },
    r2: {
        endpoint: process.env.MEDIA_R2_ENDPOINT || '',
        region: process.env.MEDIA_R2_REGION || 'auto',
        bucket: process.env.MEDIA_R2_BUCKET || '',
        accessKeyId: process.env.MEDIA_R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.MEDIA_R2_SECRET_ACCESS_KEY || '',
        forcePathStyle: false,
    },
};

const REMOTE_PROVIDERS = ['b2', 'r2'];
const KEY_PREFIX = 'vods/';

// ── Settings (media_settings, JSON values under storage_tier.*) ──
const DEFAULTS = {
    enabled: true,
    // B2 cold-offload eligibility (a VOD must meet ALL of these)
    minAgeDays: 7,
    maxViewsForCold: 5,
    minLastAccessDays: 3,
    sweepIntervalMs: 15 * 60 * 1000,
    // Disk pressure: above this % the sweep drains aggressively…
    hotDiskPressurePct: 70,
    // …until local disk is back under this %
    localLowWaterPct: 60,
    // At/above this % even recordings finished a couple of hours ago are fair game —
    // the recorder refuses new recordings when free space runs out, so draining
    // beats keeping yesterday's VOD hot.
    criticalDiskPct: 90,
    criticalMinAgeHours: 2,
    // Free-space budget, in GB, evaluated alongside the percentages. Percentages
    // alone scale badly: 30% of a 96 GB disk is one long stream, and the recorder's
    // own guard rails are in GB (VOD_DISK_WARN_GB / VOD_DISK_CRIT_GB). Drain whenever
    // free space is below minFreeGb and keep going until targetFreeGb is free again.
    minFreeGb: 25,
    targetFreeGb: 40,
    // While a drain is still needed after a pass, re-run this soon instead of waiting
    // for the regular interval — recovery from a full disk should take minutes.
    pressureRetryMs: 2 * 60 * 1000,
    // Upload deadline = floor + size / minimum acceptable throughput; a stalled
    // multipart upload is aborted instead of holding the sweep lock forever.
    uploadTimeoutFloorMs: 20 * 60 * 1000,
    uploadMinThroughputMBps: 2,
    // Raise storage.alert after this many consecutive pressure passes that freed
    // nothing (per-kind cooldown so a stuck night doesn't page every 2 minutes).
    alertAfterStalledPasses: 2,
    alertCooldownMs: 6 * 60 * 60 * 1000,
    maxPerSweep: 40,
    // R2 popularity tier
    r2Enabled: true,
    r2MinViews: 20,
    r2RecentAccessDays: 3,
    r2MaxIdleDays: 14,
    r2MaxPerSweep: 5,
};

let sweepTimer = null;
let sweepRunning = false;
const clients = {};          // providerName → S3Client
const providerHealthy = {};  // providerName → bool

// The policy is revisioned configuration (server/vod/tier-config.js, openvibe-shared/config): read from
// memory, changed only through a validated revision (setSettings, the admin config routes).
const tierConfig = require('./tier-config');
function getSetting(key) {
    try { const v = tierConfig.get(DEFAULTS).get(key); if (v !== undefined) return v; } catch (err) { console.warn('[Tiers] config unavailable:', err.message); }
    return DEFAULTS[key];
}

function getSettings() {
    const s = {};
    for (const key of Object.keys(DEFAULTS)) s[key] = getSetting(key);
    return s;
}

/** Change some settings: one validated revision merged over the active one. → the new snapshot (throws ConfigError 422/409) */
function setSettings(updates, { actor = null, reason = null } = {}) {
    return tierConfig.get(DEFAULTS).apply(updates, { merge: true, actor, reason });
}

/** Does the active revision set this key explicitly ('setting'), or is it the built-in default ('default')? */
function settingSource(key) {
    try { tierConfig.get(DEFAULTS); return tierConfig.explicitKeys().has(key) ? 'setting' : 'default'; } catch { return 'default'; }
}

// r2Enabled, r2MinViews, r2RecentAccessDays, r2MaxIdleDays, r2MaxPerSweep
const R2_THRESHOLDS = Object.keys(DEFAULTS).filter(k => /^r2[A-Z]/.test(k));
const R2_DEMOTE_PER_SWEEP = 10;

/**
 * The R2 popularity policy in force (read-only; PUT /admin/storage/tiers/settings changes it):
 * each threshold as { value, default, source }, plus the rules the sweep applies.
 */
function r2Policy(settings = getSettings()) {
    const t = {};
    for (const k of R2_THRESHOLDS) t[k] = { value: settings[k], default: DEFAULTS[k], source: settingSource(k) };
    return {
        thresholds: t,
        promote: `a local or B2 VOD that is not recording, with view_count >= r2MinViews (${settings.r2MinViews}) and last accessed within r2RecentAccessDays (${settings.r2RecentAccessDays} days); at most r2MaxPerSweep (${settings.r2MaxPerSweep}) per sweep`,
        demote: `an R2 VOD not accessed for r2MaxIdleDays (${settings.r2MaxIdleDays} days), or never; at most ${R2_DEMOTE_PER_SWEEP} per sweep; the B2 canonical copy is checked (or copied back) first, and a held VOD is never moved`,
        demote_per_sweep: R2_DEMOTE_PER_SWEEP,
    };
}

function _thresholdSnapshot(settings = getSettings()) {
    const out = {};
    for (const k of R2_THRESHOLDS) out[k] = { value: settings[k], source: settingSource(k) };
    return out;
}

function _tierInputs(vod) {
    if (!vod) return {};
    return {
        view_count: Number(vod.view_count) || 0, last_accessed_at: vod.last_accessed_at || null, storage_provider: providerOf(vod),
        is_recording: !!vod.is_recording, held: _held(vod), file_size: Number(vod.file_size) || 0, created_at: vod.created_at || null,
    };
}

function _outcomeOf(result, action, from) {
    if (!result) return 'failed';
    // Promoting a VOD R2 already serves (the copy is re-checked) changes nothing: 'already'.
    if (result.ok) return result.already || (action === 'promote' && from === 'r2') ? 'already' : 'done';
    if (result.held || /recording|not configured|not available|not found|No source/i.test(String(result.error || ''))) return 'refused';
    return 'failed';
}

/**
 * Log one R2 promotion or demotion (media_tier_decisions): what the VOD looked like, the thresholds
 * in force, why, and how it ended. Never throws: the move already happened (or did not).
 */
function recordTierDecision({ vod, vodId, action, from, to, result, trigger = 'manual', reason = 'requested' }) {
    try {
        db.run(`INSERT INTO media_tier_decisions (vod_id, app_id, object_id, action, from_provider, to_provider, outcome, trigger, reason, inputs, thresholds, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(vodId), vod ? vod.app_id : null, vod ? vod.object_id || null : null, action, from || null, to || null, _outcomeOf(result, action, from),
            String(trigger).slice(0, 40), String(reason).slice(0, 500), JSON.stringify(_tierInputs(vod)), JSON.stringify(_thresholdSnapshot()),
            result && !result.ok ? String(result.error || 'failed').slice(0, 500) : null]);
    } catch (err) {
        console.warn(`[VodStorage] tier decision for VOD ${vodId} not logged: ${err.message}`);
    }
}

// ── Provider clients ─────────────────────────────────────────

function providerConfigured(name) {
    const p = PROVIDER_ENV[name];
    return !!(p && p.endpoint && p.bucket && p.accessKeyId && p.secretAccessKey);
}

function clientFor(name) {
    if (!providerConfigured(name)) return null;
    if (!clients[name]) {
        loadSdk();
        const p = PROVIDER_ENV[name];
        clients[name] = new S3.S3Client({
            region: p.region,
            endpoint: p.endpoint,
            forcePathStyle: p.forcePathStyle,
            credentials: { accessKeyId: p.accessKeyId, secretAccessKey: p.secretAccessKey },
        });
    }
    return clients[name];
}

function bucketFor(name) {
    return (PROVIDER_ENV[name] && PROVIDER_ENV[name].bucket) || null;
}

function endpointFor(name) {
    return (PROVIDER_ENV[name] && PROVIDER_ENV[name].endpoint) || null;
}

// Object model (Wave 4): holds freeze an object's placement (moveToCold, moveToHot, promoteToR2 and
// demoteFromR2 refuse a held VOD with { ok: false, held: true }; deleteVodObjects keeps a held object's
// bytes, a clip's too while its source VOD is held), and every tier move writes the row's new
// placement (`write`) and re-projects the VOD's media_locations in one transaction (WS-G task 1;
// afterTierMove). Lazy — the model requires this module.
const objects = () => require('../objects/model');
function _held(vod) { return objects().isHeldRow(vod); }
function _moved(vodId, verified, write = null) { return objects().afterTierMove(vodId, verified, write); }
// After a move removed the local copy (the row already names the remote one): the object's locations
// follow the disk. File I/O after the commit, so a follow-up rather than part of the write.
function _localRemoved(vodId) { objects().safeSync('vod', vodId); }

function keyForVod(vod) {
    if (vod.storage_key) return vod.storage_key;
    return KEY_PREFIX + path.basename(vod.file_path || '');
}

function localPathForVod(vod) {
    return path.join(path.resolve(config.vod.path), path.basename(vod.file_path || ''));
}

function providerOf(vod) {
    const p = String(vod?.storage_provider || 'local').toLowerCase();
    return REMOTE_PROVIDERS.includes(p) ? p : 'local';
}

function isRemote(vod) {
    return providerOf(vod) !== 'local';
}

// ── S3 primitives ────────────────────────────────────────────

async function headObject(provider, key) {
    const client = clientFor(provider);
    if (!client) return null;
    try {
        const res = await client.send(new S3.HeadObjectCommand({ Bucket: PROVIDER_ENV[provider].bucket, Key: key }));
        return { size: Number(res.ContentLength || 0), etag: res.ETag || null };
    } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
        throw err;
    }
}

/** Deadline for one upload: a floor plus the time the file takes at the minimum acceptable throughput. */
function uploadTimeoutMs(bytes, settings = getSettings()) {
    const floor = Number(settings.uploadTimeoutFloorMs) || DEFAULTS.uploadTimeoutFloorMs;
    const mbps = Number(settings.uploadMinThroughputMBps) || DEFAULTS.uploadMinThroughputMBps;
    return floor + Math.ceil((Number(bytes) || 0) / (mbps * 1024 * 1024)) * 1000;
}

async function uploadFile(provider, key, filePath, contentType = 'video/webm') {
    const client = clientFor(provider);
    if (!client) throw new Error(`Provider ${provider} not configured`);
    loadSdk();
    const size = fs.statSync(filePath).size;
    // A hung multipart upload used to hold the sweep lock indefinitely (nothing else
    // could drain). Abort past the deadline so the sweep moves on to the next VOD;
    // leavePartsOnError cleans the partial multipart up on the bucket.
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new Error(`upload deadline exceeded (${Math.round(uploadTimeoutMs(size) / 60000)} min for ${(size / 1048576).toFixed(0)} MB)`)), uploadTimeoutMs(size));
    const upload = new LibStorage.Upload({
        client,
        params: {
            Bucket: PROVIDER_ENV[provider].bucket,
            Key: key,
            Body: fs.createReadStream(filePath),
            ContentType: contentType,
        },
        partSize: 64 * 1024 * 1024,
        queueSize: 3,
        leavePartsOnError: false,
        abortController: abort,
    });
    try {
        await upload.done();
    } catch (err) {
        if (abort.signal.aborted) throw (abort.signal.reason instanceof Error ? abort.signal.reason : new Error('upload aborted'));
        throw err;
    } finally {
        clearTimeout(deadline);
    }
    // Verify size before anything destructive happens
    const localSize = fs.statSync(filePath).size;
    const head = await headObject(provider, key);
    if (!head || head.size !== localSize) {
        throw new Error(`Upload verification failed for ${provider}:${key} (local ${localSize}, remote ${head ? head.size : 'missing'})`);
    }
    return { size: localSize };
}

async function copyBetweenProviders(srcProvider, dstProvider, key) {
    const src = clientFor(srcProvider);
    const dst = clientFor(dstProvider);
    if (!src || !dst) throw new Error(`Provider not configured for copy ${srcProvider}→${dstProvider}`);
    loadSdk();
    const obj = await src.send(new S3.GetObjectCommand({ Bucket: PROVIDER_ENV[srcProvider].bucket, Key: key }));
    const upload = new LibStorage.Upload({
        client: dst,
        params: {
            Bucket: PROVIDER_ENV[dstProvider].bucket,
            Key: key,
            Body: obj.Body,
            ContentType: obj.ContentType || 'video/webm',
        },
        partSize: 64 * 1024 * 1024,
        queueSize: 3,
        leavePartsOnError: false,
    });
    await upload.done();
    const expected = Number(obj.ContentLength || 0);
    const head = await headObject(dstProvider, key);
    if (!head || (expected && head.size !== expected)) {
        throw new Error(`Copy verification failed for ${key} → ${dstProvider}`);
    }
    return { size: head.size };
}

async function deleteObject(provider, key) {
    const client = clientFor(provider);
    if (!client) return;
    try {
        await client.send(new S3.DeleteObjectCommand({ Bucket: PROVIDER_ENV[provider].bucket, Key: key }));
    } catch (err) {
        console.warn(`[VodStorage] Delete ${provider}:${key} failed:`, err.message);
    }
}

/**
 * Best-effort removal of a paste's legacy B2 screenshot object(s). Legacy paste
 * screenshots live in B2 under `community.attachments/objects/<date>/…paste-
 * screenshot-<pasteId>.<ext>` (date-partitioned, key not stored in the DB), so we
 * list the prefix and delete anything matching the paste id. Silent no-op if B2 is off.
 */
async function deleteLegacyPasteScreenshot(pasteId) {
    const client = clientFor('b2');
    if (!client || !pasteId) return;
    const marker = `paste-screenshot-${pasteId}.`;
    try {
        let token;
        do {
            const r = await client.send(new S3.ListObjectsV2Command({
                Bucket: PROVIDER_ENV.b2.bucket, Prefix: 'community.attachments/', ContinuationToken: token, MaxKeys: 1000,
            }));
            for (const o of (r.Contents || [])) {
                if (o.Key.split('/').pop().includes(marker)) await deleteObject('b2', o.Key);
            }
            token = r.IsTruncated ? r.NextContinuationToken : null;
        } while (token);
    } catch (err) {
        console.warn(`[VodStorage] Legacy paste screenshot cleanup failed for paste ${pasteId}:`, err.message);
    }
}

/** Every object under `prefix` in one provider's bucket: [{ key, size, last_modified }] (read-only). */
async function listObjects(provider, prefix) {
    const client = clientFor(provider);
    if (!client) throw new Error(`${provider} is not configured`);
    loadSdk();
    const out = [];
    let token;
    do {
        const r = await client.send(new S3.ListObjectsV2Command({ Bucket: PROVIDER_ENV[provider].bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
        for (const o of (r.Contents || [])) out.push({ key: o.Key, size: Number(o.Size || 0), last_modified: o.LastModified ? new Date(o.LastModified).toISOString() : null });
        token = r.IsTruncated ? r.NextContinuationToken : null;
    } while (token);
    return out;
}

/**
 * Multipart uploads still open in one provider's bucket (started, never completed or aborted: a killed
 * process leaves them, and their parts are stored and billed): [{ key, upload_id, initiated }] (read-only).
 */
async function listMultipartUploads(provider, prefix = '') {
    const client = clientFor(provider);
    if (!client) throw new Error(`${provider} is not configured`);
    loadSdk();
    const out = [];
    let keyMarker, idMarker;
    for (;;) {
        const r = await client.send(new S3.ListMultipartUploadsCommand({ Bucket: PROVIDER_ENV[provider].bucket, Prefix: prefix || undefined,
            KeyMarker: keyMarker, UploadIdMarker: idMarker, MaxUploads: 1000 }));
        for (const u of (r.Uploads || [])) out.push({ key: u.Key, upload_id: u.UploadId, initiated: u.Initiated ? new Date(u.Initiated).toISOString() : null });
        if (!r.IsTruncated || !r.NextKeyMarker) break;
        keyMarker = r.NextKeyMarker;
        idMarker = r.NextUploadIdMarker;
    }
    return out;
}

async function presignGet(provider, key, expiresInSeconds = 900) {
    const client = clientFor(provider);
    if (!client) return null;
    loadSdk();
    // Force the response MIME so the browser plays the media even when the stored
    // object metadata is generic (legacy clips were uploaded as octet-stream).
    const ext = path.extname(key || '').toLowerCase();
    const mime = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
    return Presigner.getSignedUrl(client, new S3.GetObjectCommand({
        Bucket: PROVIDER_ENV[provider].bucket,
        Key: key,
        ...(mime ? { ResponseContentType: mime } : {}),
    }), { expiresIn: expiresInSeconds });
}

// ── Playback resolution ──────────────────────────────────────

/**
 * Returns { kind: 'file', path } for local VODs or
 * { kind: 'redirect', url, provider } for offloaded ones.
 * Falls back through r2 → b2 → local if an object is missing.
 */
async function resolvePlayback(vod) {
    const provider = providerOf(vod);
    const key = keyForVod(vod);

    if (provider !== 'local') {
        const order = provider === 'r2' ? ['r2', 'b2'] : ['b2', 'r2'];
        for (const p of order) {
            if (!providerConfigured(p) || providerHealthy[p] === false) continue;
            try {
                const url = await presignGet(p, key);
                if (url) return { kind: 'redirect', url, provider: p };
            } catch (err) {
                console.warn(`[VodStorage] Presign failed for ${p}:${key}:`, err.message);
            }
        }
    }

    const local = localPathForVod(vod);
    if (fs.existsSync(local)) return { kind: 'file', path: local };
    return null;
}

/**
 * A source ffmpeg/ffprobe can consume: local path, or a presigned https URL.
 */
async function resolveMediaSource(vod) {
    const local = localPathForVod(vod);
    if (fs.existsSync(local)) return { kind: 'file', value: local };
    if (isRemote(vod)) {
        const plan = await resolvePlayback(vod);
        if (plan?.kind === 'redirect') return { kind: 'url', value: plan.url };
    }
    return null;
}

// ── Tier moves ───────────────────────────────────────────────

function cleanupSidecar(localPath) {
    for (const seekable of [localPath.replace(/\.webm$/, '.seekable.webm'), localPath.replace(/\.mp4$/, '.seekable.mp4')]) {
        if (seekable !== localPath && fs.existsSync(seekable)) {
            try { fs.unlinkSync(seekable); } catch { /* ignore */ }
        }
    }
}

/** Offload a local VOD to B2 (cold). */
async function moveToCold(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };
    if (vod.is_recording) return { ok: false, error: 'VOD is currently recording' };
    if (_held(vod)) return { ok: false, held: true, error: 'VOD is under a retention hold' };
    if (!providerConfigured('b2')) return { ok: false, error: 'B2 not configured' };

    const key = keyForVod(vod);
    const local = localPathForVod(vod);

    try {
        if (!fs.existsSync(local)) {
            // Not local — maybe already offloaded
            if (await headObject('b2', key)) {
                _moved(vodId, ['b2'], () => db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vodId]));
                return { ok: true, already: true };
            }
            // Neither here nor in B2: nothing to offload, ever. Quarantine the row so the
            // sweep stops re-selecting it (see runSweep) and listings stop showing it.
            quarantineMissing(vodId, 'local file missing and no B2 object');
            return { ok: false, error: 'Source file missing' };
        }

        const existing = await headObject('b2', key);
        const localSize = fs.statSync(local).size;
        if (!existing || existing.size !== localSize) {
            await uploadFile('b2', key, local);
        }

        _moved(vodId, ['b2'], () => db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vodId]));
        try { fs.unlinkSync(local); } catch (err) {
            console.error(`[VodStorage] Uploaded but failed to remove local file for VOD ${vodId}:`, err.message);
        }
        cleanupSidecar(local);
        _localRemoved(vodId);

        console.log(`[VodStorage] VOD ${vodId} offloaded to B2: ${key} (${(localSize / 1048576).toFixed(1)} MB)`);
        return { ok: true, bytes: localSize };
    } catch (err) {
        console.error(`[VodStorage] Offload of VOD ${vodId} failed:`, err.message);
        return { ok: false, error: err.message };
    }
}

/** Restore an offloaded VOD to local disk. */
/** Remove half-downloaded restores left behind by a crash or a killed process (older than 1h). */
function cleanupStaleDownloads() {
    try {
        const dir = path.resolve(config.vod.path);
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.download')) continue;
            const fp = path.join(dir, f);
            try { if (Date.now() - fs.statSync(fp).mtimeMs > 3600000) { fs.unlinkSync(fp); console.log(`[VodStorage] Removed stale partial download ${f}`); } } catch { /* */ }
        }
    } catch { /* */ }
}

/** Restore an offloaded VOD to local disk. Restoring one served from R2 drops its R2 copy: logged as a demotion. */
async function moveToHot(vodId, ctx = {}) {
    const before = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    const result = await _moveToHot(vodId);
    if (before && providerOf(before) === 'r2') {
        recordTierDecision({ vod: before, vodId, action: 'demote', from: 'r2', to: 'local', result, trigger: ctx.trigger || 'manual', reason: ctx.reason || 'restored to local disk' });
    }
    return result;
}

async function _moveToHot(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };
    // A hold freezes placement: restoring would flip the row to local and drop an R2 copy.
    if (_held(vod)) return { ok: false, held: true, error: 'VOD is under a retention hold' };

    const key = keyForVod(vod);
    const local = localPathForVod(vod);

    if (fs.existsSync(local)) {
        _moved(vodId, [], () => db.run("UPDATE vods SET storage_provider = 'local' WHERE id = ?", [vodId]));
        return { ok: true, already: true };
    }

    const srcProvider = ['b2', 'r2'].find(p => providerConfigured(p));
    if (!srcProvider) return { ok: false, error: 'No remote provider configured' };

    try {
        loadSdk();
        let provider = providerOf(vod) === 'r2' ? 'r2' : 'b2';
        let head = await headObject(provider, key);
        if (!head) {
            provider = provider === 'r2' ? 'b2' : 'r2';
            head = providerConfigured(provider) ? await headObject(provider, key) : null;
        }
        if (!head) return { ok: false, error: 'Object missing from remote storage' };

        const client = clientFor(provider);
        const obj = await client.send(new S3.GetObjectCommand({ Bucket: PROVIDER_ENV[provider].bucket, Key: key }));
        const tmp = local + '.download';
        // A cloud stream can simply stop mid-file without ever erroring (seen at 7.1 of 8.9 GB),
        // which used to hang this promise — and everything queued behind it — forever. Watch the
        // file grow; no growth for STALL_MS, or blowing the overall budget, aborts the download.
        const STALL_MS = 90 * 1000;
        const budgetMs = Math.min(60 * 60000, 5 * 60000 + Math.round(head.size / (2 * 1024 * 1024)) * 1000);   // ≥2 MB/s expected
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmp);
            const started = Date.now();
            let lastSize = -1, lastGrowth = Date.now(), done = false;
            const finish = (err) => { if (done) return; done = true; clearInterval(watch); if (err) { try { obj.Body.destroy(); } catch { /* */ } try { out.destroy(); } catch { /* */ } reject(err); } else resolve(); };
            const watch = setInterval(() => {
                let size = 0; try { size = fs.statSync(tmp).size; } catch { size = 0; }
                if (size !== lastSize) { lastSize = size; lastGrowth = Date.now(); }
                if (Date.now() - lastGrowth > STALL_MS) finish(new Error(`download stalled at ${(size / 1048576).toFixed(0)} MB of ${(head.size / 1048576).toFixed(0)} MB`));
                else if (Date.now() - started > budgetMs) finish(new Error(`download exceeded ${Math.round(budgetMs / 60000)} min`));
            }, 5000);
            obj.Body.pipe(out);
            obj.Body.on('error', finish);
            out.on('error', finish);
            out.on('finish', () => finish(null));
        }).catch((err) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw err; });
        if (fs.statSync(tmp).size !== head.size) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            return { ok: false, error: 'Download verification failed' };
        }
        fs.renameSync(tmp, local);

        // Restoring to local keeps the B2 canonical copy; drop any R2 copy.
        if (providerOf(vod) === 'r2' && providerConfigured('r2')) await deleteObject('r2', key);
        _moved(vodId, [], () => db.run("UPDATE vods SET storage_provider = 'local' WHERE id = ?", [vodId]));
        console.log(`[VodStorage] VOD ${vodId} restored to local (${(head.size / 1048576).toFixed(1)} MB)`);
        return { ok: true, bytes: head.size };
    } catch (err) {
        console.error(`[VodStorage] Restore of VOD ${vodId} failed:`, err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * Promote a VOD to R2 (free egress), keeping the B2 canonical copy, and log the decision.
 * ctx { trigger: sweep | admin | drill | manual, reason } says who asked and why.
 */
async function promoteToR2(vodId, ctx = {}) {
    const before = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    const result = await _promoteToR2(vodId);
    recordTierDecision({ vod: before, vodId, action: 'promote', from: before ? providerOf(before) : null, to: 'r2', result, ...ctx });
    return result;
}

async function _promoteToR2(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };
    if (vod.is_recording) return { ok: false, error: 'VOD is currently recording' };
    if (_held(vod)) return { ok: false, held: true, error: 'VOD is under a retention hold' };
    if (!providerConfigured('r2') || providerHealthy.r2 === false) return { ok: false, error: 'R2 not available' };
    if (!providerConfigured('b2')) return { ok: false, error: 'B2 not configured' };

    const key = keyForVod(vod);
    const local = localPathForVod(vod);

    try {
        // Ensure canonical B2 copy first
        let b2Head = await headObject('b2', key);
        if (!b2Head) {
            if (!fs.existsSync(local)) return { ok: false, error: 'No source available for promotion' };
            await uploadFile('b2', key, local);
            b2Head = await headObject('b2', key);
        }

        // Put the R2 copy
        const r2Head = await headObject('r2', key);
        if (!r2Head || r2Head.size !== b2Head.size) {
            if (fs.existsSync(local)) await uploadFile('r2', key, local);
            else await copyBetweenProviders('b2', 'r2', key);
        }

        _moved(vodId, ['b2', 'r2'], () => db.run("UPDATE vods SET storage_provider = 'r2', storage_key = ? WHERE id = ?", [key, vodId]));

        // Popular VODs live in R2+B2; free the local copy
        let freed = 0;
        if (fs.existsSync(local)) {
            freed = fs.statSync(local).size;
            try { fs.unlinkSync(local); cleanupSidecar(local); } catch { freed = 0; }
            if (freed) _localRemoved(vodId);
        }

        console.log(`[VodStorage] VOD ${vodId} promoted to R2: ${key}`);
        return { ok: true, bytes: freed };
    } catch (err) {
        console.error(`[VodStorage] R2 promotion of VOD ${vodId} failed:`, err.message);
        return { ok: false, error: err.message };
    }
}

/** Demote an R2 VOD back to B2-only, and log the decision (ctx as for promoteToR2). */
async function demoteFromR2(vodId, ctx = {}) {
    const before = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    const result = await _demoteFromR2(vodId);
    recordTierDecision({ vod: before, vodId, action: 'demote', from: before ? providerOf(before) : null, to: 'b2', result, ...ctx });
    return result;
}

async function _demoteFromR2(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod) return { ok: false, error: 'VOD not found' };
    if (providerOf(vod) !== 'r2') return { ok: true, already: true };
    if (_held(vod)) return { ok: false, held: true, error: 'VOD is under a retention hold' };

    const key = keyForVod(vod);
    try {
        // Canonical must exist in B2 before we delete the R2 copy
        const b2Head = await headObject('b2', key);
        if (!b2Head) {
            const copied = await copyBetweenProviders('r2', 'b2', key).catch(() => null);
            if (!copied) return { ok: false, error: 'No B2 canonical and copy-back failed' };
        }
        await deleteObject('r2', key);
        _moved(vodId, ['b2'], () => db.run("UPDATE vods SET storage_provider = 'b2' WHERE id = ?", [vodId]));
        console.log(`[VodStorage] VOD ${vodId} demoted from R2 to B2`);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/** Delete a VOD's (or clip's — same columns) media everywhere (local + B2 + R2). */
async function deleteVodObjects(vod) {
    if (!vod?.file_path) return;
    // Last line of defence for every delete path: a held object keeps its bytes.
    if (_held(vod)) { console.warn(`[VodStorage] Not deleting media of ${vod.object_id}: under a retention hold`); return; }
    const local = localPathForVod(vod);
    if (fs.existsSync(local)) {
        try { fs.unlinkSync(local); } catch { /* ignore */ }
    }
    // Clips live in the clips dir — also try the record's own absolute path.
    if (vod.file_path !== local && fs.existsSync(vod.file_path)) {
        try { fs.unlinkSync(vod.file_path); } catch { /* ignore */ }
    }
    cleanupSidecar(local);
    const key = keyForVod(vod);
    for (const p of REMOTE_PROVIDERS) {
        if (providerConfigured(p)) await deleteObject(p, key);
    }
}

// ── Disk usage ───────────────────────────────────────────────

function diskUsage(targetPath) {
    try {
        const resolved = path.resolve(targetPath);
        const output = execSync(`df -B1 "${resolved}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
        const parts = output.trim().split(/\s+/);
        if (parts.length >= 6) {
            return {
                total: parseInt(parts[1], 10) || 0,
                used: parseInt(parts[2], 10) || 0,
                available: parseInt(parts[3], 10) || 0,
                usePct: parseFloat(parts[4]) || 0,
                mount: parts[5] || '/',
            };
        }
    } catch { /* ignore */ }
    return { total: 0, used: 0, available: 0, usePct: 0, mount: '/' };
}

function dirStats(dirPath) {
    let bytes = 0, files = 0;
    try {
        const resolved = path.resolve(dirPath);
        if (!fs.existsSync(resolved)) return { bytes: 0, files: 0 };
        for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
            if (entry.isFile()) {
                try { bytes += fs.statSync(path.join(resolved, entry.name)).size; files++; } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
    return { bytes, files };
}

// ── Sweep ────────────────────────────────────────────────────

/**
 * Rows the offload sweep may pick: a local, finished VOD with a file path that is
 * not already quarantined as file-less. Ghost rows (a shell created for a recording
 * that never produced a file, or a legacy path from before the media split) satisfy
 * the naive "storage_provider = local" test but fail instantly with "Source file
 * missing" — and under disk pressure they filled the whole candidate LIMIT every
 * sweep, so the real multi-GB recordings behind them were never reached and the
 * disk sat at 96%+ while the log said "draining" every 15 minutes.
 */
const OFFLOADABLE_WHERE = `
    COALESCE(storage_provider, 'local') = 'local'
    AND COALESCE(is_recording, 0) = 0
    AND file_path IS NOT NULL
    AND COALESCE(health_status, 'ok') NOT IN ('missing_file', 'zero_byte')`;

function quarantineMissing(vodId, reason) {
    try {
        objects().withObject('vod', vodId, () => db.run(`UPDATE vods
                SET health_status = 'missing_file',
                    health_issues_json = ?,
                    last_health_scan_at = datetime('now'),
                    quarantined_at = COALESCE(quarantined_at, datetime('now')),
                    is_public = 0
                WHERE id = ?`, [JSON.stringify(['missing_file', reason]), vodId]));
    } catch (err) {
        console.warn(`[VodStorage] Could not quarantine VOD ${vodId}:`, err.message);
    }
}

/**
 * Quarantine finished local rows that never got a file (file_path NULL) once they are
 * an hour old — by then the recorder would have opened the file if it ever was going
 * to. Returns how many rows were newly quarantined.
 */
function reconcileGhosts() {
    try {
        // The rows and their objects (-> failed) in one transaction.
        const ids = objects().withObject('vod', (found) => found, () => {
            const found = db.all(`SELECT id FROM vods
                WHERE COALESCE(storage_provider, 'local') = 'local'
                  AND COALESCE(is_recording, 0) = 0
                  AND file_path IS NULL
                  AND created_at <= datetime('now', '-1 hour')
                  AND COALESCE(health_status, 'ok') NOT IN ('missing_file', 'zero_byte')`).map(r => r.id);
            if (found.length) {
                db.run(`UPDATE vods
                    SET health_status = 'missing_file',
                        health_issues_json = ?,
                        last_health_scan_at = datetime('now'),
                        quarantined_at = COALESCE(quarantined_at, datetime('now')),
                        is_public = 0
                    WHERE id IN (${found.map(() => '?').join(',')})`,
                [JSON.stringify(['missing_file', 'recording never produced a file']), ...found]);
            }
            return found;
        });
        return ids.length;
    } catch (err) {
        console.warn('[VodStorage] Ghost reconcile failed:', err.message);
        return 0;
    }
}

// A VOD whose upload just failed (network blip, B2 5xx, a 15 GB multipart that timed
// out) must not be retried on every sweep ahead of everything else — it would pin the
// drain on one file. Skip it for a while and let the next candidates proceed.
const OFFLOAD_RETRY_BACKOFF_MS = 30 * 60 * 1000;
const offloadFailedAt = new Map(); // vodId → epoch ms of the last failed upload

// ── Drain policy (pure — unit-tested) ────────────────────────

const GB = 1024 * 1024 * 1024;

/** Drain when either the percentage ceiling or the free-space floor is crossed. */
function needsDrain(disk, settings) {
    if (!disk || !disk.total) return false;
    const freeGb = disk.available / GB;
    return disk.usePct >= settings.hotDiskPressurePct || freeGb < settings.minFreeGb;
}

/** A drain may stop only when BOTH the percentage and the free-space target are met. */
function drainSatisfied(disk, settings) {
    if (!disk || !disk.total) return true;
    const freeGb = disk.available / GB;
    return disk.usePct <= settings.localLowWaterPct && freeGb >= settings.targetFreeGb;
}

function isCritical(disk, settings) {
    return !!disk && !!disk.total && disk.usePct >= settings.criticalDiskPct;
}

/**
 * When to run the next pass: soon while a drain is still needed (progress was made,
 * or candidates are merely in retry back-off), the regular interval otherwise.
 */
function planNextDelayMs(result, settings) {
    if (result && result.stillNeedsDrain && (result.migrated || result.skippedBackoff || result.errors)) {
        return settings.pressureRetryMs;
    }
    return settings.sweepIntervalMs;
}

// ── Sweep state + alerts ─────────────────────────────────────

const sweepState = {
    lastRunAt: null,
    lastResult: null,
    nextRunAt: null,
    startedAt: null,
    stalledPasses: 0,   // consecutive pressure passes that freed nothing
    stalled: false,
};
const alertLastSentAt = new Map(); // kind → epoch ms

/**
 * Tell every app with a webhook that storage needs a human (or that it recovered).
 * Delivered as the regular Media→app webhook (`storage.alert` / `storage.recovered`),
 * so Live can log it loudly and page whatever ops channel it has configured.
 */
async function emitStorageEvent(event, kind, data, settings = getSettings()) {
    const cooldownKey = `${event}:${kind}`;
    const last = alertLastSentAt.get(cooldownKey) || 0;
    if (event === 'storage.alert' && Date.now() - last < settings.alertCooldownMs) return false;
    alertLastSentAt.set(cooldownKey, Date.now());
    const payload = { kind, ...data, at: new Date().toISOString() };
    (event === 'storage.alert' ? console.error : console.warn)(`[VodStorage] ${event} (${kind}): ${JSON.stringify(data)}`);
    // No database state changes here (the cooldown is in memory): the outbox row is the whole
    // commit, queued once for every app; each app's webhook carries its event_id.
    let eventId = null;
    try {
        const events = require('../events');
        const env = db.getDb().transaction(() => events.record(event, null, payload))();
        eventId = env ? env.event_id : null;
        events.kick();
    } catch (err) { console.warn(`[VodStorage] ${event} not queued for Events:`, err.message); }
    let apps = [];
    try { apps = db.listApps().filter(a => a.webhook_url); } catch { apps = []; }
    let webhooks;
    try { webhooks = require('../webhooks'); } catch { return false; }
    await Promise.all(apps.map(app => webhooks.sendWebhook(app.app_id, event, payload, { eventId }).catch(() => false)));
    return true;
}

async function runSweep() {
    if (sweepRunning) return { skipped: true, reason: 'already running' };
    sweepRunning = true;

    try {
        const settings = getSettings();
        if (!settings.enabled) return { skipped: true, reason: 'disabled' };
        if (!providerConfigured('b2')) return { skipped: true, reason: 'B2 not configured' };
        if (providerHealthy.b2 === false) return { skipped: true, reason: 'B2 unhealthy' };

        let migrated = 0, bytesFreed = 0, promoted = 0, demoted = 0;
        const errors = [];

        sweepState.startedAt = Date.now();
        const disk = diskUsage(config.vod.path);
        const underPressure = needsDrain(disk, settings);
        const critical = isCritical(disk, settings);
        const ghosts = reconcileGhosts();

        // 1) Cold offload to B2
        let candidates;
        if (underPressure) {
            const minAge = critical ? `-${settings.criticalMinAgeHours} hours` : '-1 day';
            console.log(`[VodStorage] Disk at ${disk.usePct}%, ${(disk.available / GB).toFixed(1)} GB free (${critical ? 'CRITICAL' : 'pressure'}) — draining to ≤${settings.localLowWaterPct}% / ≥${settings.targetFreeGb} GB free`
                + (ghosts ? `; quarantined ${ghosts} file-less VOD row(s)` : ''));
            candidates = db.all(`
                SELECT id, file_path, file_size FROM vods
                WHERE ${OFFLOADABLE_WHERE}
                  AND created_at <= datetime('now', ?)
                ORDER BY (last_accessed_at IS NOT NULL), last_accessed_at ASC, view_count ASC, file_size DESC
                LIMIT 200
            `, [minAge]);
        } else {
            if (ghosts) console.log(`[VodStorage] Quarantined ${ghosts} file-less VOD row(s)`);
            candidates = db.all(`
                SELECT id, file_path, file_size FROM vods
                WHERE ${OFFLOADABLE_WHERE}
                  AND created_at <= datetime('now', ?)
                  AND COALESCE(view_count, 0) <= ?
                  AND (last_accessed_at IS NULL OR last_accessed_at <= datetime('now', ?))
                ORDER BY view_count ASC, file_size DESC
                LIMIT ?
            `, [`-${settings.minAgeDays} days`, settings.maxViewsForCold, `-${settings.minLastAccessDays} days`, settings.maxPerSweep]);
        }

        let skippedBackoff = 0, skippedHeld = 0, quarantined = ghosts;
        for (const vod of candidates) {
            if (underPressure && drainSatisfied(diskUsage(config.vod.path), settings)) break;
            const failedAt = offloadFailedAt.get(vod.id);
            if (failedAt && Date.now() - failedAt < OFFLOAD_RETRY_BACKOFF_MS) { skippedBackoff++; continue; }
            // Verify the file before spending an upload slot on it; a row whose file is
            // gone (legacy path, manual deletion) is quarantined, not retried forever.
            if (!fs.existsSync(localPathForVod(vod))) {
                const key = keyForVod(vod);
                if (await headObject('b2', key).catch(() => null)) {
                    _moved(vod.id, ['b2'], () => db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vod.id]));
                } else {
                    quarantineMissing(vod.id, `file not found at ${localPathForVod(vod)}`);
                    quarantined++;
                }
                continue;
            }
            const result = await moveToCold(vod.id);
            if (result.ok) {
                offloadFailedAt.delete(vod.id);
                if (!result.already) { migrated++; bytesFreed += result.bytes || 0; }
            } else if (result.held) {
                skippedHeld++;
            } else {
                offloadFailedAt.set(vod.id, Date.now());
                errors.push({ id: vod.id, error: result.error });
            }
        }

        // Say what happened whenever it matters: the old sweep only logged on success, so
        // weeks of "draining" that freed nothing looked healthy in the journal.
        if (underPressure || errors.length || quarantined || skippedHeld) {
            const freedMb = (bytesFreed / 1048576).toFixed(1);
            console.log(`[VodStorage] Offload pass: ${candidates.length} candidate(s), ${migrated} uploaded (${freedMb} MB freed), `
                + `${errors.length} failed, ${skippedBackoff} in retry back-off, ${quarantined} quarantined`
                + (skippedHeld ? `, ${skippedHeld} under a retention hold` : '')
                + (underPressure ? `, disk now ${diskUsage(config.vod.path).usePct}%` : ''));
            for (const e of errors.slice(0, 5)) console.warn(`[VodStorage]   VOD ${e.id}: ${e.error}`);
            if (underPressure && !migrated && !candidates.length) {
                console.warn('[VodStorage] Disk is under pressure but nothing is eligible to offload — check for stuck recordings or non-VOD files in the VOD directory');
            }
        }

        // Stall detection: a pressure pass that freed nothing is the failure mode that
        // went unnoticed for weeks. Count them, and after a couple in a row raise an
        // alert through the app webhooks; announce recovery once the drain works again.
        const diskAfter = diskUsage(config.vod.path);
        const stillNeedsDrain = underPressure && !drainSatisfied(diskAfter, settings);
        if (underPressure && !migrated) {
            sweepState.stalledPasses++;
            if (sweepState.stalledPasses >= settings.alertAfterStalledPasses) {
                sweepState.stalled = true;
                await emitStorageEvent('storage.alert', 'drain_stalled', {
                    disk_pct: diskAfter.usePct,
                    free_gb: Number((diskAfter.available / GB).toFixed(1)),
                    stalled_passes: sweepState.stalledPasses,
                    candidates: candidates.length,
                    errors: errors.slice(0, 3),
                    hint: !candidates.length
                        ? 'nothing eligible to offload (stuck recordings? non-VOD files in the VOD directory?)'
                        : errors.length ? 'uploads failing — check B2 credentials/bucket and network' : 'all candidates in retry back-off',
                }, settings);
            }
        } else {
            if (sweepState.stalled) {
                await emitStorageEvent('storage.recovered', 'drain_recovered', {
                    disk_pct: diskAfter.usePct,
                    free_gb: Number((diskAfter.available / GB).toFixed(1)),
                    uploaded: migrated,
                }, settings);
            }
            sweepState.stalledPasses = 0;
            sweepState.stalled = false;
        }
        if (critical && stillNeedsDrain) {
            await emitStorageEvent('storage.alert', 'disk_critical', {
                disk_pct: diskAfter.usePct,
                free_gb: Number((diskAfter.available / GB).toFixed(1)),
                uploaded_this_pass: migrated,
                hint: 'recorder refuses new recordings below VOD_DISK_CRIT_GB; drain in progress',
            }, settings);
        }

        // 2) R2 promotion for popular VODs
        if (settings.r2Enabled && providerConfigured('r2') && providerHealthy.r2 !== false) {
            const popular = db.all(`
                SELECT id, view_count, last_accessed_at FROM vods
                WHERE COALESCE(storage_provider, 'local') IN ('local', 'b2')
                  AND COALESCE(is_recording, 0) = 0
                  AND COALESCE(view_count, 0) >= ?
                  AND last_accessed_at IS NOT NULL
                  AND last_accessed_at >= datetime('now', ?)
                LIMIT ?
            `, [settings.r2MinViews, `-${settings.r2RecentAccessDays} days`, settings.r2MaxPerSweep]);
            for (const vod of popular) {
                const result = await promoteToR2(vod.id, { trigger: 'sweep',
                    reason: `view_count ${vod.view_count || 0} >= r2MinViews ${settings.r2MinViews} and last accessed ${vod.last_accessed_at} (within r2RecentAccessDays ${settings.r2RecentAccessDays})` });
                if (result.ok && !result.already) { promoted++; bytesFreed += result.bytes || 0; }
                else if (result.held) skippedHeld++;
                else if (!result.ok) errors.push({ id: vod.id, error: result.error });
            }

            // 3) R2 demotion for stale VODs
            const stale = db.all(`
                SELECT id, last_accessed_at FROM vods
                WHERE storage_provider = 'r2'
                  AND (last_accessed_at IS NULL OR last_accessed_at <= datetime('now', ?))
                LIMIT ${R2_DEMOTE_PER_SWEEP}
            `, [`-${settings.r2MaxIdleDays} days`]);
            for (const vod of stale) {
                const result = await demoteFromR2(vod.id, { trigger: 'sweep',
                    reason: `last accessed ${vod.last_accessed_at || 'never'} (idle longer than r2MaxIdleDays ${settings.r2MaxIdleDays})` });
                if (result.ok && !result.already) demoted++;
            }
        }

        const summary = {
            checked: candidates.length,
            migrated,
            promoted,
            demoted,
            bytesFreed,
            underPressure,
            critical,
            stillNeedsDrain,
            skippedBackoff,
            skippedHeld,
            quarantined,
            diskPct: diskAfter.usePct,
            freeGb: Number((diskAfter.available / GB).toFixed(1)),
            errors: errors.length ? errors : undefined,
            timestamp: new Date().toISOString(),
        };
        sweepState.lastRunAt = Date.now();
        sweepState.lastResult = summary;
        if (migrated || promoted || demoted) {
            console.log(`[VodStorage] Sweep: ${migrated} → B2, ${promoted} → R2, ${demoted} R2→B2, ${(bytesFreed / 1048576).toFixed(1)} MB freed locally`);
        }
        return summary;
    } catch (err) {
        console.error('[VodStorage] Sweep error:', err.message);
        return { error: err.message };
    } finally {
        sweepRunning = false;
        sweepState.startedAt = null;
    }
}

// ── Health + lifecycle ───────────────────────────────────────

async function checkProviders() {
    if (!providerConfigured('b2') && !providerConfigured('r2')) {
        providerHealthy.b2 = false;
        providerHealthy.r2 = false;
        console.log('[VodStorage] No object-storage providers configured — local-only mode');
        return { ...providerHealthy };
    }
    loadSdk();
    for (const name of REMOTE_PROVIDERS) {
        if (!providerConfigured(name)) { providerHealthy[name] = false; continue; }
        try {
            await clientFor(name).send(new S3.HeadBucketCommand({ Bucket: PROVIDER_ENV[name].bucket }));
            providerHealthy[name] = true;
        } catch (err) {
            // R2 bucket may not exist yet — try to create it
            if (name === 'r2') {
                try {
                    await clientFor(name).send(new S3.CreateBucketCommand({ Bucket: PROVIDER_ENV[name].bucket }));
                    providerHealthy[name] = true;
                    console.log('[VodStorage] Created R2 bucket:', PROVIDER_ENV[name].bucket);
                    continue;
                } catch (createErr) {
                    console.warn('[VodStorage] R2 bucket create failed:', createErr.message);
                }
            }
            providerHealthy[name] = false;
            console.warn(`[VodStorage] Provider ${name} unavailable:`, err.message);
        }
    }
    console.log(`[VodStorage] Providers — b2: ${providerHealthy.b2 ? 'ok' : 'unavailable'}, r2: ${providerHealthy.r2 ? 'ok' : 'unavailable'}`);
    return { ...providerHealthy };
}

/**
 * One-time migration from the legacy hot/cold columns: rows imported with
 * storage_tier='cold' were uploaded to B2 at vods/<basename> by the old rclone
 * mount — verify and flip them to provider 'b2'.
 */
async function migrateLegacy() {
    if (!providerConfigured('b2')) return;
    const legacy = db.all(`
        SELECT id, file_path FROM vods
        WHERE storage_tier = 'cold' AND COALESCE(storage_provider, 'local') = 'local'
    `);
    if (!legacy.length) return;
    let flipped = 0, restoredLocal = 0;
    for (const vod of legacy) {
        const key = KEY_PREFIX + path.basename(vod.file_path || '');
        try {
            const head = await headObject('b2', key);
            if (head) {
                _moved(vod.id, ['b2'], () => db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vod.id]));
                flipped++;
            } else if (fs.existsSync(localPathForVod(vod))) {
                restoredLocal++; // still local, sweep will re-offload
            } else {
                console.warn(`[VodStorage] Legacy cold VOD ${vod.id} missing from B2 and local disk`);
            }
        } catch (err) {
            console.warn(`[VodStorage] Legacy migration check failed for VOD ${vod.id}:`, err.message);
        }
    }
    console.log(`[VodStorage] Legacy migration: ${flipped} cold VOD(s) mapped to B2${restoredLocal ? `, ${restoredLocal} still local` : ''}`);
}

// The sweep is a self-rescheduling chain, not a fixed interval: after a pass that
// left the disk still needing a drain it comes back in pressureRetryMs, otherwise in
// sweepIntervalMs. A sweep that overran its deadline is reported by the watchdog
// (the upload abort in uploadFile is what actually frees it).
const SWEEP_WATCHDOG_MS = 3 * 60 * 60 * 1000;

function scheduleNext(delayMs) {
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    sweepState.nextRunAt = Date.now() + delayMs;
    sweepTimer = setTimeout(async () => {
        sweepTimer = null;
        let result = null;
        try {
            result = await runSweep();
        } catch (err) {
            console.error('[VodStorage] Sweep failed:', err.message);
        }
        if (result && result.skipped && result.reason === 'already running'
            && sweepState.startedAt && Date.now() - sweepState.startedAt > SWEEP_WATCHDOG_MS) {
            console.error(`[VodStorage] Watchdog: a sweep has been running for ${Math.round((Date.now() - sweepState.startedAt) / 60000)} min — an upload is probably hung`);
        }
        scheduleNext(planNextDelayMs(result, getSettings()));
    }, delayMs);
    if (sweepTimer.unref) sweepTimer.unref();
}

// A new policy revision restarts a running sweep with it (as PUT /tiers/settings always did).
tierConfig.setOnApplied(() => { if (sweepTimer) { stop(); start(); } });

function start() {
    stop();
    const settings = getSettings();
    if (!settings.enabled) {
        console.log('[VodStorage] Disabled — not starting sweep timer');
        return;
    }
    console.log(`[VodStorage] Starting sweep (every ${(settings.sweepIntervalMs / 60000).toFixed(0)} min, every ${(settings.pressureRetryMs / 60000).toFixed(0)} min while draining)`);
    scheduleNext(30_000);
}

function stop() {
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    sweepState.nextRunAt = null;
}

// ── Status ───────────────────────────────────────────────────

// List prices used for the admin cost estimate (storage only; egress noted).
const CLOUD_PRICING = {
    b2: { storagePerGbMonth: 0.006, egressPerGb: 0.01, freeGb: 0, egressNote: 'First 3× storage free/day, then $0.01/GB' },
    r2: { storagePerGbMonth: 0.015, egressPerGb: 0,    freeGb: 10, egressNote: 'Egress is free' },
};

let _bucketUsageCache = null;

/**
 * Scan each configured object-store bucket for real usage (object count + bytes,
 * broken down by top-level prefix). Cached for 10 min — a full ListObjectsV2 walk
 * is expensive. `force` bypasses the cache.
 */
async function getBucketUsage(force = false) {
    if (!force && _bucketUsageCache && (Date.now() - _bucketUsageCache.at) < 10 * 60 * 1000) {
        return _bucketUsageCache.data;
    }
    loadSdk();
    const out = {};
    for (const provider of REMOTE_PROVIDERS) {
        if (!providerConfigured(provider)) { out[provider] = { configured: false }; continue; }
        const client = clientFor(provider);
        let objects = 0, bytes = 0, token;
        const prefixes = {};
        try {
            do {
                const r = await client.send(new S3.ListObjectsV2Command({
                    Bucket: PROVIDER_ENV[provider].bucket, ContinuationToken: token, MaxKeys: 1000,
                }));
                for (const o of (r.Contents || [])) {
                    const size = Number(o.Size || 0);
                    objects++; bytes += size;
                    const top = (o.Key.includes('/') ? o.Key.split('/')[0] : '(root)');
                    if (!prefixes[top]) prefixes[top] = { objects: 0, bytes: 0 };
                    prefixes[top].objects++; prefixes[top].bytes += size;
                }
                token = r.IsTruncated ? r.NextContinuationToken : null;
            } while (token);
            out[provider] = { configured: true, bucket: PROVIDER_ENV[provider].bucket, objects, bytes, prefixes };
        } catch (err) {
            out[provider] = { configured: true, bucket: PROVIDER_ENV[provider].bucket, error: err.message };
        }
    }
    _bucketUsageCache = { at: Date.now(), data: out };
    return out;
}

/** Estimate monthly storage cost from bucket usage using list prices. */
function estimateCloudCosts(usage) {
    const costs = { pricing: CLOUD_PRICING };
    let totalStorage = 0;
    for (const provider of REMOTE_PROVIDERS) {
        const u = usage?.[provider];
        const price = CLOUD_PRICING[provider];
        if (!u || !u.configured || u.error) { costs[provider] = null; continue; }
        const gb = u.bytes / 1e9;
        const billableGb = Math.max(0, gb - price.freeGb);
        const storageMonthly = billableGb * price.storagePerGbMonth;
        totalStorage += storageMonthly;
        costs[provider] = {
            gb,
            objects: u.objects,
            storagePerGbMonth: price.storagePerGbMonth,
            storageMonthly,
            egressPerGb: price.egressPerGb,
            egressNote: price.egressNote,
        };
    }
    costs.totalStorageMonthly = totalStorage;
    return costs;
}

/**
 * Sanitized bucket configuration + a cheap live HeadBucket reachability probe
 * per provider. NEVER includes credentials (endpoint/bucket/region only).
 */
async function bucketStatus() {
    const out = {};
    for (const name of REMOTE_PROVIDERS) {
        const p = PROVIDER_ENV[name];
        const configured = providerConfigured(name);
        const entry = {
            configured,
            endpoint: p.endpoint || null,
            bucket: p.bucket || null,
            region: p.region || null,
            healthy: providerHealthy[name] !== false,   // last known state
            reachable: false,                            // live probe below
        };
        if (configured) {
            try {
                loadSdk();
                await clientFor(name).send(new S3.HeadBucketCommand({ Bucket: p.bucket }));
                entry.reachable = true;
                providerHealthy[name] = true;
            } catch (err) {
                entry.error = err.name || err.message;
                providerHealthy[name] = false;
                entry.healthy = false;
            }
        }
        out[name] = entry;
    }
    return out;
}

/** Live HeadBucket probe of one configured provider (readiness); throws when unreachable. */
async function probeProvider(name) {
    if (!providerConfigured(name)) throw new Error(`${name} is not configured`);
    loadSdk();
    try {
        await clientFor(name).send(new S3.HeadBucketCommand({ Bucket: PROVIDER_ENV[name].bucket }));
        providerHealthy[name] = true;
        return true;
    } catch (err) {
        providerHealthy[name] = false;
        throw new Error(`${name} HeadBucket failed: ${err.name || 'error'}`);
    }
}

function getStatus() {
    const settings = getSettings();
    const localDisk = diskUsage(config.vod.path);
    const localStats = dirStats(config.vod.path);

    const counts = db.get(`
        SELECT
            SUM(CASE WHEN COALESCE(storage_provider, 'local') = 'local' THEN 1 ELSE 0 END) as localCount,
            SUM(CASE WHEN storage_provider = 'b2' THEN 1 ELSE 0 END) as b2Count,
            SUM(CASE WHEN storage_provider = 'r2' THEN 1 ELSE 0 END) as r2Count,
            SUM(CASE WHEN COALESCE(storage_provider, 'local') = 'local' THEN file_size ELSE 0 END) as localBytes,
            SUM(CASE WHEN storage_provider = 'b2' THEN file_size ELSE 0 END) as b2Bytes,
            SUM(CASE WHEN storage_provider = 'r2' THEN file_size ELSE 0 END) as r2Bytes
    FROM vods
    `) || {};

    let clipCounts = {};
    try {
        clipCounts = db.get(`
            SELECT
                SUM(CASE WHEN COALESCE(storage_provider, 'local') = 'local' THEN 1 ELSE 0 END) as localCount,
                SUM(CASE WHEN storage_provider = 'b2' THEN 1 ELSE 0 END) as b2Count,
                SUM(CASE WHEN storage_provider = 'r2' THEN 1 ELSE 0 END) as r2Count
            FROM clips
        `) || {};
    } catch { clipCounts = {}; }

    return {
        settings,
        engine: 'local+b2+r2',
        providers: {
            b2: { configured: providerConfigured('b2'), healthy: providerHealthy.b2 !== false, bucket: PROVIDER_ENV.b2.bucket },
            r2: { configured: providerConfigured('r2'), healthy: providerHealthy.r2 !== false, bucket: PROVIDER_ENV.r2.bucket },
        },
        local: { disk: localDisk, vods: { bytes: localStats.bytes, files: localStats.files } },
        tiers: {
            local: { count: counts.localCount || 0, bytes: counts.localBytes || 0 },
            b2: { count: counts.b2Count || 0, bytes: counts.b2Bytes || 0 },
            r2: { count: counts.r2Count || 0, bytes: counts.r2Bytes || 0 },
        },
        clipTiers: {
            local: { count: clipCounts.localCount || 0 },
            b2: { count: clipCounts.b2Count || 0 },
            r2: { count: clipCounts.r2Count || 0 },
        },
        sweepRunning,
        sweep: {
            running: sweepRunning,
            startedAt: sweepState.startedAt ? new Date(sweepState.startedAt).toISOString() : null,
            lastRunAt: sweepState.lastRunAt ? new Date(sweepState.lastRunAt).toISOString() : null,
            nextRunAt: sweepState.nextRunAt ? new Date(sweepState.nextRunAt).toISOString() : null,
            lastResult: sweepState.lastResult,
            stalled: sweepState.stalled,
            stalledPasses: sweepState.stalledPasses,
            needsDrain: needsDrain(localDisk, settings),
            critical: isCritical(localDisk, settings),
        },
    };
}

module.exports = {
    cleanupStaleDownloads,
    DEFAULTS,
    OFFLOADABLE_WHERE,
    needsDrain,
    drainSatisfied,
    isCritical,
    planNextDelayMs,
    uploadTimeoutMs,
    providerOf,
    isRemote,
    providerConfigured,
    bucketFor,
    endpointFor,
    headObject,
    listObjects,
    listMultipartUploads,
    keyForVod,
    localPathForVod,
    resolvePlayback,
    resolveMediaSource,
    moveToCold,
    moveToHot,
    promoteToR2,
    demoteFromR2,
    r2Policy,
    recordTierDecision,
    deleteVodObjects,
    deleteObject,
    deleteLegacyPasteScreenshot,
    presignGet,
    runSweep,
    reconcileGhosts,
    quarantineMissing,
    checkProviders,
    migrateLegacy,
    start,
    stop,
    getStatus,
    bucketStatus,
    probeProvider,
    getBucketUsage,
    estimateCloudCosts,
    getSettings,
    setSettings,
    tierConfig,
    diskUsage,
    dirStats,
};

// ── CLI: node server/vod/vod-storage.js <check|migrate-legacy|drain [pct]> ──
if (require.main === module) {
    (async () => {
        const cmd = process.argv[2];
        if (cmd === 'check') {
            await checkProviders();
            console.log(JSON.stringify(getStatus().tiers, null, 2));
            process.exit(0);
        }
        if (cmd === 'migrate-legacy') {
            await checkProviders();
            await migrateLegacy();
            process.exit(0);
        }
        if (cmd === 'drain') {
            await checkProviders();
            const target = Number(process.argv[3] || getSetting('localLowWaterPct'));
            console.log(`[VodStorage] CLI drain to ${target}% disk usage`);
            for (let round = 0; round < 50; round++) {
                const disk = diskUsage(config.vod.path);
                console.log(`[VodStorage] Disk at ${disk.usePct}%`);
                if (disk.usePct <= target) break;
                const eligible = db.all(`
                    SELECT id FROM vods
                    WHERE COALESCE(storage_provider, 'local') = 'local'
                      AND COALESCE(is_recording, 0) = 0
                      AND created_at <= datetime('now', '-1 day')
                    ORDER BY (last_accessed_at IS NOT NULL), last_accessed_at ASC, view_count ASC, file_size DESC
                    LIMIT 10
                `);
                if (!eligible.length) { console.log('[VodStorage] Nothing left to drain'); break; }
                for (const vod of eligible) {
                    const r = await moveToCold(vod.id);
                    if (!r.ok) console.warn(`  VOD ${vod.id}: ${r.error}`);
                }
            }
            process.exit(0);
        }
        console.log('Usage: node server/vod/vod-storage.js <check|migrate-legacy|drain [targetPct]>');
        process.exit(1);
    })().catch(err => { console.error(err); process.exit(1); });
}
