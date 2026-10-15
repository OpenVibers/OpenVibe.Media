'use strict';
/**
 * Thumbnail variants (Media Fabric F4, docs/media-fabric.md §5): GET /t/:id?w=<width>&fmt=<format> answers the
 * thumbnail resized to a width on a fixed ladder and re-encoded, so a grid of cards downloads what it shows (a 640 px
 * JPEG of about 24 KB is about 13 KB as a 480 px WebP). A variant is a rebuildable derivative: made on its first
 * request, kept in a bounded local cache, and dropped least recently used when the cache is over its budget.
 *
 *   parse(query)  → null (no variant asked: the original), { w, fmt }, or { error }
 *                   w snaps up to the ladder (160, 320, 480, 640; never wider than the source); fmt is webp (the
 *                   default once w is given), avif or jpeg. The format is named in the URL, never negotiated from
 *                   Accept: Cloudflare caches by URL and ignores Vary.
 *   createVariants({ dir, maxBytes, concurrency, sharp }) → { get(srcPath, spec) → { file, size, type } | null }
 *                   null when the cache is busy (more than `queueMax` waiting): the caller serves the original.
 *
 * The cache key holds the source's name and modification time, so a live thumbnail that is rewritten gets a fresh
 * variant (the old one ages out). Each variant is written to a temporary name and renamed, so a reader never sees a
 * partial file. The decoder refuses images over 40 megapixels.
 */
const fs = require('fs');
const path = require('path');

const LADDER = [160, 320, 480, 640];
const FORMATS = Object.freeze({ webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg' });

function parse(query = {}) {
    const hasW = query.w !== undefined && query.w !== '';
    const hasFmt = query.fmt !== undefined && query.fmt !== '';
    if (!hasW && !hasFmt) return null;
    const fmt = hasFmt ? String(query.fmt).toLowerCase() : 'webp';
    if (!FORMATS[fmt]) return { error: 'fmt must be webp, avif or jpeg' };
    let w = LADDER[LADDER.length - 1];
    if (hasW) {
        const n = Number(query.w);
        if (!Number.isInteger(n) || n < 1 || n > 4096) return { error: 'w must be a whole number of pixels from 1 to 4096' };
        w = LADDER.find((x) => x >= n) || LADDER[LADDER.length - 1];
    }
    return { w, fmt };
}

function createVariants({ dir, maxBytes = 512 * 1024 * 1024, concurrency = 2, queueMax = 64, sharp = null, log = console } = {}) {
    const inflight = new Map();   // key → promise of the made variant
    const waiting = [];
    let running = 0;
    let total = null;             // bytes in the cache, counted on first use

    const lib = () => sharp || require('sharp');
    const ensureDir = () => fs.mkdirSync(dir, { recursive: true });
    function count() {
        if (total !== null) return;
        ensureDir();
        total = 0;
        for (const f of fs.readdirSync(dir)) {
            try { total += fs.statSync(path.join(dir, f)).size; } catch { /* gone */ }
        }
    }
    async function slot(fn) {
        if (running >= concurrency) await new Promise((resolve) => waiting.push(resolve));
        running++;
        try { return await fn(); } finally {
            running--;
            const next = waiting.shift();
            if (next) next();
        }
    }
    /** Drop the least recently used variants until the cache is under 90 % of its budget. */
    function evict() {
        if (total <= maxBytes) return;
        const files = [];
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.tmp')) continue;
            try { const st = fs.statSync(path.join(dir, f)); files.push({ f, size: st.size, at: st.mtimeMs }); } catch { /* gone */ }
        }
        files.sort((a, b) => a.at - b.at);
        for (const x of files) {
            if (total <= maxBytes * 0.9) break;
            try { fs.unlinkSync(path.join(dir, x.f)); total -= x.size; } catch { /* gone */ }
        }
    }
    async function make(srcPath, key, spec) {
        const file = path.join(dir, key);
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        let img = lib()(srcPath, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().resize({ width: spec.w, withoutEnlargement: true });
        img = spec.fmt === 'avif' ? img.avif({ quality: 50, effort: 2 }) : spec.fmt === 'jpeg' ? img.jpeg({ quality: 80, mozjpeg: true }) : img.webp({ quality: 75 });
        await img.toFile(tmp);
        fs.renameSync(tmp, file);
        const size = fs.statSync(file).size;
        total += size;
        evict();
        return { file, size, type: FORMATS[spec.fmt] };
    }

    return {
        LADDER, FORMATS,
        stats: () => ({ bytes: total, running, waiting: waiting.length }),
        async get(srcPath, spec) {
            count();
            const st = fs.statSync(srcPath);
            const key = `${path.basename(srcPath)}.${Math.floor(st.mtimeMs)}.${spec.w}.${spec.fmt}`;
            const file = path.join(dir, key);
            try {
                const hit = fs.statSync(file);
                const now = new Date();
                try { fs.utimesSync(file, now, now); } catch { /* evicted meanwhile */ }
                return { file, size: hit.size, type: FORMATS[spec.fmt], hit: true };
            } catch { /* not made yet */ }
            if (inflight.has(key)) return await inflight.get(key);
            if (running >= concurrency && waiting.length >= queueMax) return null;
            const p = slot(() => make(srcPath, key, spec)).finally(() => inflight.delete(key));
            inflight.set(key, p);
            try { return await p; } catch (err) {
                log.warn(`[Thumbnails] variant ${key}: ${err.message}`);
                throw err;
            }
        },
    };
}

module.exports = { parse, createVariants, LADDER, FORMATS };
