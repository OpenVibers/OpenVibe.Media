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

function getSetting(key) {
    try {
        const row = db.get('SELECT value FROM media_settings WHERE key = ?', [`storage_tier.${key}`]);
        if (row) return JSON.parse(row.value);
    } catch { /* use default */ }
    return DEFAULTS[key];
}

function getSettings() {
    const s = {};
    for (const key of Object.keys(DEFAULTS)) s[key] = getSetting(key);
    return s;
}

function setSetting(key, value) {
    if (!(key in DEFAULTS)) return;
    const dbKey = `storage_tier.${key}`;
    const existing = db.get('SELECT key FROM media_settings WHERE key = ?', [dbKey]);
    if (existing) db.run('UPDATE media_settings SET value = ? WHERE key = ?', [JSON.stringify(value), dbKey]);
    else db.run('INSERT INTO media_settings (key, value) VALUES (?, ?)', [dbKey, JSON.stringify(value)]);
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

async function uploadFile(provider, key, filePath, contentType = 'video/webm') {
    const client = clientFor(provider);
    if (!client) throw new Error(`Provider ${provider} not configured`);
    loadSdk();
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
    });
    await upload.done();
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
    if (!providerConfigured('b2')) return { ok: false, error: 'B2 not configured' };

    const key = keyForVod(vod);
    const local = localPathForVod(vod);

    try {
        if (!fs.existsSync(local)) {
            // Not local — maybe already offloaded
            if (await headObject('b2', key)) {
                db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vodId]);
                return { ok: true, already: true };
            }
            return { ok: false, error: 'Source file missing' };
        }

        const existing = await headObject('b2', key);
        const localSize = fs.statSync(local).size;
        if (!existing || existing.size !== localSize) {
            await uploadFile('b2', key, local);
        }

        db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vodId]);
        try { fs.unlinkSync(local); } catch (err) {
            console.error(`[VodStorage] Uploaded but failed to remove local file for VOD ${vodId}:`, err.message);
        }
        cleanupSidecar(local);

        console.log(`[VodStorage] VOD ${vodId} offloaded to B2: ${key} (${(localSize / 1048576).toFixed(1)} MB)`);
        return { ok: true, bytes: localSize };
    } catch (err) {
        console.error(`[VodStorage] Offload of VOD ${vodId} failed:`, err.message);
        return { ok: false, error: err.message };
    }
}

/** Restore an offloaded VOD to local disk. */
async function moveToHot(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };

    const key = keyForVod(vod);
    const local = localPathForVod(vod);

    if (fs.existsSync(local)) {
        db.run("UPDATE vods SET storage_provider = 'local' WHERE id = ?", [vodId]);
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
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmp);
            obj.Body.pipe(out);
            obj.Body.on('error', reject);
            out.on('error', reject);
            out.on('finish', resolve);
        });
        if (fs.statSync(tmp).size !== head.size) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            return { ok: false, error: 'Download verification failed' };
        }
        fs.renameSync(tmp, local);

        // Restoring to local keeps the B2 canonical copy; drop any R2 copy.
        if (providerOf(vod) === 'r2' && providerConfigured('r2')) await deleteObject('r2', key);
        db.run("UPDATE vods SET storage_provider = 'local' WHERE id = ?", [vodId]);
        console.log(`[VodStorage] VOD ${vodId} restored to local (${(head.size / 1048576).toFixed(1)} MB)`);
        return { ok: true, bytes: head.size };
    } catch (err) {
        console.error(`[VodStorage] Restore of VOD ${vodId} failed:`, err.message);
        return { ok: false, error: err.message };
    }
}

/** Promote a popular VOD to R2 (free egress). Keeps the B2 canonical copy. */
async function promoteToR2(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod || !vod.file_path) return { ok: false, error: 'VOD not found' };
    if (vod.is_recording) return { ok: false, error: 'VOD is currently recording' };
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

        db.run("UPDATE vods SET storage_provider = 'r2', storage_key = ? WHERE id = ?", [key, vodId]);

        // Popular VODs live in R2+B2; free the local copy
        let freed = 0;
        if (fs.existsSync(local)) {
            freed = fs.statSync(local).size;
            try { fs.unlinkSync(local); cleanupSidecar(local); } catch { freed = 0; }
        }

        console.log(`[VodStorage] VOD ${vodId} promoted to R2: ${key}`);
        return { ok: true, bytes: freed };
    } catch (err) {
        console.error(`[VodStorage] R2 promotion of VOD ${vodId} failed:`, err.message);
        return { ok: false, error: err.message };
    }
}

/** Demote a stale R2 VOD back to B2-only. */
async function demoteFromR2(vodId) {
    const vod = db.get('SELECT * FROM vods WHERE id = ?', [vodId]);
    if (!vod) return { ok: false, error: 'VOD not found' };
    if (providerOf(vod) !== 'r2') return { ok: true, already: true };

    const key = keyForVod(vod);
    try {
        // Canonical must exist in B2 before we delete the R2 copy
        const b2Head = await headObject('b2', key);
        if (!b2Head) {
            const copied = await copyBetweenProviders('r2', 'b2', key).catch(() => null);
            if (!copied) return { ok: false, error: 'No B2 canonical and copy-back failed' };
        }
        await deleteObject('r2', key);
        db.run("UPDATE vods SET storage_provider = 'b2' WHERE id = ?", [vodId]);
        console.log(`[VodStorage] VOD ${vodId} demoted from R2 to B2`);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/** Delete a VOD's (or clip's — same columns) media everywhere (local + B2 + R2). */
async function deleteVodObjects(vod) {
    if (!vod?.file_path) return;
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

        const disk = diskUsage(config.vod.path);
        const underPressure = disk.usePct >= settings.hotDiskPressurePct;

        // 1) Cold offload to B2
        let candidates;
        if (underPressure) {
            console.log(`[VodStorage] Disk at ${disk.usePct}% (pressure ≥ ${settings.hotDiskPressurePct}%) — draining to ${settings.localLowWaterPct}%`);
            candidates = db.all(`
                SELECT id, file_path, file_size FROM vods
                WHERE COALESCE(storage_provider, 'local') = 'local'
                  AND COALESCE(is_recording, 0) = 0
                  AND created_at <= datetime('now', '-1 day')
                ORDER BY (last_accessed_at IS NOT NULL), last_accessed_at ASC, view_count ASC, file_size DESC
                LIMIT 100
            `);
        } else {
            candidates = db.all(`
                SELECT id, file_path, file_size FROM vods
                WHERE COALESCE(storage_provider, 'local') = 'local'
                  AND COALESCE(is_recording, 0) = 0
                  AND created_at <= datetime('now', ?)
                  AND COALESCE(view_count, 0) <= ?
                  AND (last_accessed_at IS NULL OR last_accessed_at <= datetime('now', ?))
                ORDER BY view_count ASC, file_size DESC
                LIMIT ?
            `, [`-${settings.minAgeDays} days`, settings.maxViewsForCold, `-${settings.minLastAccessDays} days`, settings.maxPerSweep]);
        }

        for (const vod of candidates) {
            if (underPressure && diskUsage(config.vod.path).usePct <= settings.localLowWaterPct) break;
            const result = await moveToCold(vod.id);
            if (result.ok && !result.already) { migrated++; bytesFreed += result.bytes || 0; }
            else if (!result.ok) errors.push({ id: vod.id, error: result.error });
        }

        // 2) R2 promotion for popular VODs
        if (settings.r2Enabled && providerConfigured('r2') && providerHealthy.r2 !== false) {
            const popular = db.all(`
                SELECT id FROM vods
                WHERE COALESCE(storage_provider, 'local') IN ('local', 'b2')
                  AND COALESCE(is_recording, 0) = 0
                  AND COALESCE(view_count, 0) >= ?
                  AND last_accessed_at IS NOT NULL
                  AND last_accessed_at >= datetime('now', ?)
                LIMIT ?
            `, [settings.r2MinViews, `-${settings.r2RecentAccessDays} days`, settings.r2MaxPerSweep]);
            for (const vod of popular) {
                const result = await promoteToR2(vod.id);
                if (result.ok && !result.already) { promoted++; bytesFreed += result.bytes || 0; }
                else if (!result.ok) errors.push({ id: vod.id, error: result.error });
            }

            // 3) R2 demotion for stale VODs
            const stale = db.all(`
                SELECT id FROM vods
                WHERE storage_provider = 'r2'
                  AND (last_accessed_at IS NULL OR last_accessed_at <= datetime('now', ?))
                LIMIT 10
            `, [`-${settings.r2MaxIdleDays} days`]);
            for (const vod of stale) {
                const result = await demoteFromR2(vod.id);
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
            errors: errors.length ? errors : undefined,
            timestamp: new Date().toISOString(),
        };
        if (migrated || promoted || demoted) {
            console.log(`[VodStorage] Sweep: ${migrated} → B2, ${promoted} → R2, ${demoted} R2→B2, ${(bytesFreed / 1048576).toFixed(1)} MB freed locally`);
        }
        return summary;
    } catch (err) {
        console.error('[VodStorage] Sweep error:', err.message);
        return { error: err.message };
    } finally {
        sweepRunning = false;
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
                db.run("UPDATE vods SET storage_provider = 'b2', storage_key = ? WHERE id = ?", [key, vod.id]);
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

function start() {
    stop();
    const settings = getSettings();
    if (!settings.enabled) {
        console.log('[VodStorage] Disabled — not starting sweep timer');
        return;
    }
    console.log(`[VodStorage] Starting sweep timer (every ${(settings.sweepIntervalMs / 60000).toFixed(0)} min)`);
    setTimeout(() => {
        runSweep().catch(err => console.error('[VodStorage] Sweep failed:', err.message));
        sweepTimer = setInterval(() => {
            runSweep().catch(err => console.error('[VodStorage] Sweep failed:', err.message));
        }, settings.sweepIntervalMs);
        if (sweepTimer.unref) sweepTimer.unref();
    }, 30_000).unref?.();
}

function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
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
    };
}

module.exports = {
    DEFAULTS,
    providerOf,
    isRemote,
    keyForVod,
    localPathForVod,
    resolvePlayback,
    resolveMediaSource,
    moveToCold,
    moveToHot,
    promoteToR2,
    demoteFromR2,
    deleteVodObjects,
    deleteObject,
    deleteLegacyPasteScreenshot,
    presignGet,
    runSweep,
    checkProviders,
    migrateLegacy,
    start,
    stop,
    getStatus,
    bucketStatus,
    getBucketUsage,
    estimateCloudCosts,
    getSettings,
    setSetting,
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
