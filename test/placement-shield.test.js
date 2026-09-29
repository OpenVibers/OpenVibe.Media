'use strict';
// Origin shield (Media Fabric F1b): which reads nginx serves from its slice cache, and the purge of a deleted object.
const assert = require('assert');

(async () => {
    const shield = require('../server/placement/shield');
    const url = 'https://s3.us-west-004.backblazeb2.com/ov-vods/vods/a%20b.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';

    delete process.env.MEDIA_SHIELD;
    assert.strictEqual(shield.target({ provider: 'b2', url }), null, 'off unless MEDIA_SHIELD names the provider');

    process.env.MEDIA_SHIELD = 'b2';
    assert.strictEqual(shield.target({ provider: 'b2', url, host: 'edge.openvibe.media' }), null, 'no edge host configured: off');
    process.env.MEDIA_SHIELD_HOST = 'edge.openvibe.media';
    assert.strictEqual(shield.target({ provider: 'b2', url, host: 'openvibe.media' }), null, 'never on the Cloudflare-proxied host');
    const host = 'edge.openvibe.media';
    assert.strictEqual(shield.target({ provider: 'b2', url, host }), '/_media_shield/b2/ov-vods/vods/a%20b.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc',
        'the path-style path and the signed query ride into the internal location unchanged');
    assert.strictEqual(shield.target({ provider: 'r2', url, host }), null, 'R2 is not shielded in F1b');
    assert.strictEqual(shield.target({ provider: 'b2', url, host, visibility: 'private' }), null, 'private bytes never enter the shared cache');
    assert.strictEqual(shield.target({ provider: 'b2', url, host, sandbox: true }), null, 'sandbox bytes never enter it either');
    assert.strictEqual(shield.target({ provider: 'b2', url: 'not a url', host }), null);
    assert.strictEqual(shield.target({ provider: 'b2', url: 'https://s3.example.com/', host }), null, 'a URL without an object path is not shielded');

    // send(): the route's headers plus the internal redirect, an empty 200.
    const res = { h: {}, set(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, end() { this.ended = true; return this; } };
    shield.send(res, '/_media_shield/b2/x', { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=300', Skip: null });
    assert.deepStrictEqual([res.code, res.ended, res.h['X-Accel-Redirect'], res.h['Content-Type'], 'Skip' in res.h], [200, true, '/_media_shield/b2/x', 'video/mp4', false]);

    // purge(): one refresh request per 10 MB slice, loopback, with the public Host and each slice's exact range.
    const calls = [];
    const fetchImpl = async (u, opts) => { calls.push([u, opts.headers.Host, opts.headers.Range]); return { arrayBuffer: async () => new ArrayBuffer(0) }; };
    const r = await shield.purge({ provider: 'b2', key: 'vods/a b.mp4', size: 25 * 1024 * 1024, presign: async () => url, fetchImpl });
    assert.deepStrictEqual([r.purged, r.slices, r.failed], [3, 3, 0]);
    assert.ok(calls.every(([u, h]) => u.startsWith('http://127.0.0.1:8479/_media_shield_refresh/b2/ov-vods/vods/a%20b.mp4?') && h === 'edge.openvibe.media'), JSON.stringify(calls[0]));
    assert.deepStrictEqual(calls.map((c) => c[2]), ['bytes=0-10485759', 'bytes=10485760-20971519', 'bytes=20971520-31457279']);
    assert.deepStrictEqual(await shield.purge({ provider: 'r2', key: 'k', size: 1, presign: async () => url, fetchImpl }), { purged: 0, skipped: true }, 'nothing to purge off the shield');

    delete process.env.MEDIA_SHIELD; delete process.env.MEDIA_SHIELD_HOST;
    console.log('placement-shield: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
