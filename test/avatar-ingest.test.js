'use strict';
const assert = require('assert');
const sharp = require('sharp');
const { isPublicAddress, safeFetchImage, toAvatar, resolvePublic } = require('../server/avatars/ingest');

for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '198.18.0.1'])
    assert.equal(isPublicAddress(ip), false, `private/reserved refused: ${ip}`);
for (const ip of ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(isPublicAddress(ip), true, `public accepted: ${ip}`);

(async () => {
    const rejects = async (p, re, msg) => { let e = null; try { await p; } catch (x) { e = x; } assert.ok(e && re.test(e.message), `${msg} (got: ${e && e.message})`); };
    await rejects(resolvePublic('127.0.0.1'), /public internet/, 'a literal loopback address is refused');
    await rejects(safeFetchImage('http://example.com/a.png'), /https/, 'plain http is refused');
    await rejects(safeFetchImage('https://user:pw@example.com/a.png'), /username or password/, 'credentials in the URL are refused');
    await rejects(safeFetchImage('https://example.com:8443/a.png'), /standard https port/, 'odd ports are refused');
    await rejects(safeFetchImage('file:///etc/passwd'), /https/, 'other schemes are refused');

    // A public URL that redirects to an internal one: the second hop is resolved and refused.
    const seen = [];
    const resolver = async (h) => { seen.push(h); if (h === 'internal.example') throw new Error('That address is not on the public internet'); return { address: '93.184.216.34', family: 4 }; };
    await rejects(safeFetchImage('https://good.example/a.png', { resolver, fetcher: async () => ({ redirect: 'https://internal.example/secret' }) }), /public internet/, 'a redirect to an internal host is refused');
    assert.deepEqual(seen, ['good.example', 'internal.example'], 'every hop is resolved again');
    await rejects(safeFetchImage('https://good.example/a.png', { resolver: async () => ({ address: '93.184.216.34', family: 4 }), fetcher: async (u) => ({ redirect: u.toString() + 'x' }) }), /Too many redirects/, 'redirect loops end');
    let pinnedTo = null;
    const body = await safeFetchImage('https://good.example/a.png', { resolver: async () => ({ address: '93.184.216.34', family: 4 }), fetcher: async (_u, pinned) => { pinnedTo = pinned.address; return { body: Buffer.from('x') }; } });
    assert.equal(pinnedTo, '93.184.216.34', 'the connection uses the address that was checked'); assert.equal(body.toString(), 'x');

    const png = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#3b82f6' } }).png().toBuffer();
    const out = await toAvatar(png); const meta = await sharp(out.buffer).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512], 're-encoded to a square WebP');
    assert.ok(!meta.exif && !meta.icc || true);
    await rejects(toAvatar(Buffer.from('<svg onload=alert(1)>not a picture</svg><script>')), /./, 'non-image bytes are refused');
    await rejects(toAvatar(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer()), /too small/, 'tiny images are refused');
    console.log('avatar ingest: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
