'use strict';
/**
 * Restore-drill mode: MEDIA_DRILL=1 (`ovhost drill media`, see OpenVibe.Host docs/restore-drills.md).
 *
 * A drill starts a second Media from the production checkout, with the production env file, against
 * a restored copy of media.db on a spare loopback port, and compares its public reads with
 * production's. That instance must serve reads from the copy and do nothing else. With MEDIA_DRILL:
 *
 *   - assertSafe(): Media refuses to start unless DB_PATH is set and lies outside the checkout and
 *     outside /opt/openvibe.media (so it cannot be production's media.db), PORT is set and is not
 *     production's 4100, and HOST is loopback. It runs before the database is opened.
 *   - installGuards(): no outbound connection (net.Socket#connect, fetch), so no webhook, event, B2/R2
 *     or Network call leaves the process; no program other than git (child_process: no ffmpeg or
 *     ffprobe ever; git only reads the checkout for /release.json); no UDP socket (RTP ingest); nothing
 *     listens but the drill's own HTTP port.
 *   - readOnly: 403 for every request that is not GET, HEAD or OPTIONS, on every path.
 *   - refuseBytes(): every route that would stream a stored file (or redirect to its B2/R2 copy)
 *     answers 503. The database holds absolute paths to production's files; a drill never opens them.
 *     Watch pages and the media index render from the database only and still answer.
 *   - server/index.js opens the database and serves HTTP, and starts nothing else: no app seeding, no
 *     JWKS refresh, no health job, junk sweep, tiering sweep, clip re-cuts, copy verification, jobs
 *     worker (thumbnails, split/remux, invariant scans), disk guardian, thumbnail cleanup, object purge,
 *     backfill, orphan-recording finalize or Events relay; webhooks are never sent. Timers that modules
 *     start when they are loaded check `enabled` as well. Readiness does not probe storage (a drill
 *     writes none) or the remote tiers.
 *
 * The guards are there so that anything this list missed fails closed instead of reaching production.
 */
const path = require('path');
const fs = require('fs');

const TRUE = new Set(['1', 'true', 'on', 'yes']);

/** MEDIA_DRILL as a switch (1/true/on/yes). */
function parse(value) {
    return TRUE.has(String(value == null ? '' : value).trim().toLowerCase());
}

const enabled = parse(process.env.MEDIA_DRILL);

const REPO_ROOT = path.resolve(__dirname, '..');
/** Where production runs (OpenVibe.Host inventory: repo /opt/openvibe.media, database data/media.db). */
const PRODUCTION_ROOT = '/opt/openvibe.media';
const PRODUCTION_PORT = 4100;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function isLoopbackHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(h) || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The real location of p, following symlinks on the part of it that exists. */
function realish(p) {
    let head = path.resolve(p);
    const tail = [];
    for (;;) {
        try { return path.join(fs.realpathSync(head), ...tail.reverse()); } catch { /* not there (yet) */ }
        const parent = path.dirname(head);
        if (parent === head) return path.resolve(p);
        tail.push(path.basename(head));
        head = parent;
    }
}

function inside(p, root) {
    const rel = path.relative(root, p);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why this environment is not safe for a drill ([] = safe). Pure, for tests.
 * `repoRoot` is the checkout the process runs from; `cwd` resolves relative paths.
 */
function problems(env = process.env, { repoRoot = REPO_ROOT, cwd = process.cwd() } = {}) {
    const out = [];
    const roots = [...new Set([repoRoot, realish(repoRoot), PRODUCTION_ROOT])];
    const productionDb = new Set([path.join(PRODUCTION_ROOT, 'data', 'media.db'), path.join(repoRoot, 'data', 'media.db'), path.join(cwd, 'data', 'media.db')]);
    if (!env.DB_PATH) {
        out.push('DB_PATH is not set; it must name the restored copy of media.db');
    } else {
        const abs = path.resolve(cwd, env.DB_PATH);
        const real = realish(abs);
        const root = roots.find((r) => inside(abs, r) || inside(real, r));
        if (productionDb.has(abs) || productionDb.has(real)) out.push(`DB_PATH (${abs}) is production's database; point it at the restored copy`);
        else if (root) out.push(`DB_PATH (${abs}${real !== abs ? ` → ${real}` : ''}) is inside ${root}; a drill writes nothing in the checkout or in production's data`);
    }
    if (!isLoopbackHost(env.HOST)) out.push(`HOST (${env.HOST || 'unset, i.e. 0.0.0.0'}) is not loopback; a drill binds 127.0.0.1 only`);
    const port = Number(env.PORT);
    if (!env.PORT || !Number.isInteger(port) || port < 1 || port > 65535) out.push('PORT is not set; it must be the drill\'s own port');
    else if (port === PRODUCTION_PORT) out.push(`PORT ${port} is production's port`);
    return out;
}

class DrillRefused extends Error {
    constructor(list) {
        super(`MEDIA_DRILL: refusing to start a restore-drill instance: ${list.join('; ')}`);
        this.code = 'MEDIA_DRILL_UNSAFE';
        this.problems = list;
    }
}

/** Throws DrillRefused unless the environment is safe for a drill. */
function assertSafe(env = process.env, opts) {
    const list = problems(env, opts);
    if (list.length) throw new DrillRefused(list);
}

// ── Guards ───────────────────────────────────────────────────

const blocked = [];   // what the guards refused (newest last, bounded): { at, kind, target }
function note(kind, target) {
    blocked.push({ at: new Date().toISOString(), kind, target: String(target).slice(0, 200) });
    if (blocked.length > 50) blocked.shift();
    console.warn(`[Drill] refused ${kind}: ${target}`);
}

function drillError(message, code) {
    const err = new Error(`${message} (MEDIA_DRILL: a restore-drill instance does not do this)`);
    err.code = code;
    return err;
}

/** Where a net.Socket#connect call is going: { host, port } or { path }. */
function connectTarget(args) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0];   // net.connect() hands Socket#connect its normalized [options, cb]
    if (a && typeof a === 'object') return a.path != null ? { path: String(a.path) } : { host: a.host, port: Number(a.port) };
    if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: a };
    return { host: typeof args[1] === 'string' ? args[1] : undefined, port: Number(a) };
}

const ALLOWED_PROGRAMS = new Set(['git']);

function programOf(fn, args) {
    const first = args[0];
    if (fn === 'exec' || fn === 'execSync') return String(first || '').trim().split(/\s+/)[0] || '';
    if (fn === 'fork') return 'node';
    return String(first || '');
}

let installed = false;

/**
 * Replace the process's ways out with ones that refuse (drill only). `port` is the drill's HTTP
 * port: the one address the process may connect to (itself, on loopback) and the one it may listen on.
 */
function installGuards({ port = Number(process.env.PORT) } = {}) {
    if (installed) return;
    installed = true;
    const net = require('net');
    const util = require('util');

    const isSelf = (t) => t && t.path == null && t.port === port && (t.host == null || isLoopbackHost(t.host));

    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function drillConnect(...args) {
        const t = connectTarget(args);
        if (isSelf(t)) return connect.apply(this, args);
        const where = t.path != null ? t.path : `${t.host || 'localhost'}:${t.port}`;
        note('connection', where);
        const err = drillError(`connect ECONNREFUSED ${where}`, 'ECONNREFUSED');
        err.syscall = 'connect';
        process.nextTick(() => this.destroy(err));
        return this;
    };

    if (typeof globalThis.fetch === 'function') {
        const fetch = globalThis.fetch;
        globalThis.fetch = function drillFetch(input, init) {
            let url = null;
            try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { /* */ }
            if (url && isSelf({ host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })) return fetch(input, init);
            note('fetch', url ? url.origin + url.pathname : String(input));
            return Promise.reject(new TypeError('fetch failed', { cause: drillError(`connect ECONNREFUSED ${url ? url.host : ''}`, 'ECONNREFUSED') }));
        };
    }

    const cp = require('child_process');
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const orig = cp[fn];
        if (typeof orig !== 'function') continue;
        const check = (args) => {
            const program = programOf(fn, args);
            if (ALLOWED_PROGRAMS.has(path.basename(program))) return;
            note('program', program);
            throw drillError(`${fn}(${program}) refused`, 'EDRILL');
        };
        const guarded = function (...args) { check(args); return orig.apply(this, args); };
        const custom = orig[util.promisify.custom];
        if (custom) guarded[util.promisify.custom] = (...args) => { check(args); return custom(...args); };
        cp[fn] = guarded;
    }

    const dgram = require('dgram');
    dgram.createSocket = function drillUdp() {
        note('udp socket', 'dgram.createSocket');
        throw drillError('UDP socket refused', 'EDRILL');
    };

    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function drillListen(...args) {
        const a = args[0];
        const p = a && typeof a === 'object' ? Number(a.port) : Number(a);
        if (p === port && !(a && typeof a === 'object' && (a.fd != null || a.path != null))) return listen.apply(this, args);
        note('listener', a && typeof a === 'object' ? JSON.stringify(a) : String(a));
        throw drillError(`listen ${a && typeof a === 'object' ? JSON.stringify(a) : a} refused`, 'EDRILL');
    };
}

// ── HTTP ─────────────────────────────────────────────────────

/** Express middleware: reads only. */
function readOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.status(403).json({ error: 'This is a restore-drill instance (MEDIA_DRILL): it serves reads only', code: 'media.drill_read_only' });
}

/**
 * Answer a request for stored bytes: a drill never opens a file path from the database (they are
 * production's files) and never hands out a B2/R2 URL for one. Returns true when it answered.
 */
function refuseBytes(res) {
    if (!enabled) return false;
    if (!res.headersSent) {
        res.status(503).set('Retry-After', '3600').json({ error: 'This is a restore-drill instance (MEDIA_DRILL): it serves no stored media', code: 'media.drill_no_bytes' });
    }
    return true;
}

module.exports = {
    enabled,
    parse,
    problems,
    assertSafe,
    DrillRefused,
    installGuards,
    readOnly,
    refuseBytes,
    blocked,
    isLoopbackHost,
    PRODUCTION_ROOT,
    REPO_ROOT,
};
