'use strict';
// Origin shield (Media Fabric F1b): which reads nginx serves from its slice cache, and the purge of a deleted object.
const assert = require('assert');

(async () => {
    const shield = require('../server/placement/shield');
    const url = 'https://s3.us-west-004.backblazeb2.com/ov-vods/vods/a%20b.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';

    delete process.env.MEDIA_SHIELD;
    assert.strictEqual(shield.target({ provider: 'b2', url }), null, 'off unless MEDIA_SHIELD names the provider');

    process.env.MEDIA_SHIELD = 'b2';
    assert.strictEqual(shield.target({ provider: 'b2', url, edge: 'edge.openvibe.media' }), null, 'no edge host configured: off');
    process.env.MEDIA_SHIELD_HOST = 'edge.openvibe.media';
    assert.strictEqual(shield.target({ provider: 'b2', url, edge: null }), null, 'never on the Cloudflare-proxied host (nginx sends no edge header there)');
    const edge = 'edge.openvibe.media';
    assert.strictEqual(shield.target({ provider: 'b2', url, edge }), '/_media_shield/b2/ov-vods/vods/a%20b.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc',
        'the path-style path and the signed query ride into the internal location unchanged');
    assert.strictEqual(shield.target({ provider: 'r2', url, edge }), null, 'R2 is not shielded in F1b');
    assert.strictEqual(shield.target({ provider: 'b2', url, edge, visibility: 'private' }), null, 'private bytes never enter the shared cache');
    assert.strictEqual(shield.target({ provider: 'b2', url, edge, sandbox: true }), null, 'sandbox bytes never enter it either');
    assert.strictEqual(shield.target({ provider: 'b2', url: 'not a url', edge }), null);
    assert.strictEqual(shield.target({ provider: 'b2', url: `https://${shield.B2_UPSTREAM_HOST}/`, edge }), null, 'a URL without an object path is not shielded');
    // SigV4 signs the Host: a URL signed for another B2 endpoint would 403 on every slice through nginx, so it keeps its 302.
    assert.strictEqual(shield.target({ provider: 'b2', url: url.replace('s3.us-west-004', 's3.eu-central-003'), edge }), null, 'another B2 host is never shielded');

    // The edge comes from the header only the edge server block sets: never from Host or X-Forwarded-Host.
    const req = (h) => ({ get: (k) => h[k.toLowerCase()] });
    assert.strictEqual(shield.onEdge(req({ 'x-media-shield-host': 'edge.openvibe.media' })), true);
    assert.strictEqual(shield.onEdge(req({ host: 'edge.openvibe.media', 'x-forwarded-host': 'edge.openvibe.media' })), false, 'a client-chosen Host or X-Forwarded-Host is not the edge');
    assert.strictEqual(shield.onEdge(req({ 'x-media-shield-host': 'openvibe.media' })), false);

    // The nginx side of the same rules (the config is what enforces them on the host).
    const fs = require('fs'), path = require('path');
    const conf = (f) => fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', f), 'utf8');
    const upstream = conf('media-shield-b2-upstream.conf');
    assert.ok(upstream.includes(`proxy_set_header Host ${shield.B2_UPSTREAM_HOST};`) && upstream.includes(`proxy_pass https://${shield.B2_UPSTREAM_HOST};`), 'nginx proxies to the host shield.js signs for');
    const edgeConf = conf('edge.openvibe.media.conf'), mainConf = conf('openvibe.media.conf');
    assert.match(edgeConf, /proxy_set_header X-Media-Shield-Host \$server_name;/, 'the edge block vouches for itself');
    assert.match(mainConf, /proxy_set_header X-Media-Shield-Host "";/, 'openvibe.media clears the header a client could send through Cloudflare');
    for (const c of [edgeConf, mainConf]) assert.match(c, /proxy_set_header X-Forwarded-Host "";/);
    for (const d of ['client_max_body_size 4096m;', 'proxy_read_timeout 3600s;', 'location = /metrics { return 404; }']) assert.ok(edgeConf.includes(d), `the edge block has ${d}`);
    assert.match(conf('media-shield.http.conf'), /allow 127\.0\.0\.1;\s*deny all;/, 'only loopback may refresh the cache');

    // send(): the route's headers plus the internal redirect, an empty 200.
    const res = { h: {}, set(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, end() { this.ended = true; return this; } };
    shield.send(res, '/_media_shield/b2/x', { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=300', Skip: null });
    assert.deepStrictEqual([res.code, res.ended, res.h['X-Accel-Redirect'], res.h['Content-Type'], 'Skip' in res.h], [200, true, '/_media_shield/b2/x', 'video/mp4', false]);

    // purge(): one refresh request per 10 MB slice to the loopback listener, each slice's exact range, a few at a time.
    const calls = [];
    let inFlight = 0, peak = 0;
    const fetchImpl = async (u, opts) => {
        inFlight++; peak = Math.max(peak, inFlight); calls.push([u, opts.headers.Range]);
        await new Promise((r) => setTimeout(r, 5)); inFlight--;
        return { arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const r = await shield.purge({ provider: 'b2', key: 'vods/a b.mp4', size: 25 * 1024 * 1024, presign: async () => url, fetchImpl });
    assert.deepStrictEqual([r.purged, r.slices, r.failed], [3, 3, 0]);
    assert.ok(calls.every(([u]) => u.startsWith('http://127.0.0.1:8479/_media_shield_refresh/b2/ov-vods/vods/a%20b.mp4?')), JSON.stringify(calls[0]));
    assert.deepStrictEqual(calls.map((c) => c[1]).sort(), ['bytes=0-10485759', 'bytes=10485760-20971519', 'bytes=20971520-31457279']);
    calls.length = 0; peak = 0;
    const big = await shield.purge({ provider: 'b2', key: 'vods/a b.mp4', size: 40 * 10 * 1024 * 1024, presign: async () => url, fetchImpl });
    assert.deepStrictEqual([big.purged, big.slices], [40, 40]);
    assert.ok(peak <= 4 && peak > 1, `a large object refreshes a few slices at a time (peak ${peak})`);
    assert.deepStrictEqual(await shield.purge({ provider: 'r2', key: 'k', size: 1, presign: async () => url, fetchImpl }), { purged: 0, skipped: true }, 'nothing to purge off the shield');

    delete process.env.MEDIA_SHIELD; delete process.env.MEDIA_SHIELD_HOST;
    console.log('placement-shield: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
