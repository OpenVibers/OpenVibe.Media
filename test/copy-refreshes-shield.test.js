'use strict';
// copyBetweenProviders over a shielded key that already exists refreshes the shield's slices, as uploadFile does
// (11-20, VOD 6554: R2's repaired recording copied over B2's fragmented original, which the edge would otherwise keep
// serving for up to a day). A copy to a new key, or to a provider the shield does not front, refreshes nothing.
//   node test/copy-refreshes-shield.test.js
const assert = require('assert');
const path = require('path');

process.env.MEDIA_B2_ENDPOINT = 'https://b2.test'; process.env.MEDIA_B2_BUCKET = 'ov-vods';
process.env.MEDIA_B2_KEY_ID = 'test-id'; process.env.MEDIA_B2_APP_KEY = 'test-key';
process.env.MEDIA_R2_ENDPOINT = 'https://r2.test'; process.env.MEDIA_R2_BUCKET = 'ov-r2';
process.env.MEDIA_R2_ACCESS_KEY_ID = 'test-id'; process.env.MEDIA_R2_SECRET_ACCESS_KEY = 'test-key';

// Stand-ins for the S3 SDK: objects per provider (by endpoint), a copy is a GetObject piped into an Upload.
const store = { 'https://b2.test': new Map(), 'https://r2.test': new Map() };
class Cmd { constructor(input) { this.input = input; } }
class HeadObjectCommand extends Cmd {}
class GetObjectCommand extends Cmd {}
class S3Client {
    constructor({ endpoint }) { this.objects = store[endpoint]; }
    async send(cmd) {
        const o = this.objects.get(cmd.input.Key);
        if (!o) { const e = new Error('NotFound'); e.name = 'NotFound'; throw e; }
        if (cmd instanceof HeadObjectCommand) return { ContentLength: o.size };
        return { Body: { bytes: o.size }, ContentLength: o.size, ContentType: 'video/mp4' };
    }
}
class Upload {
    constructor({ client, params }) { this.client = client; this.params = params; }
    async done() { this.client.objects.set(this.params.Key, { size: this.params.Body.bytes }); }
}
const fake = (name, exports) => {
    const file = require.resolve(name, { paths: [path.join(__dirname, '..')] });
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
fake('@aws-sdk/client-s3', { S3Client, HeadObjectCommand, GetObjectCommand });
fake('@aws-sdk/lib-storage', { Upload });
fake('@aws-sdk/s3-request-presigner', { getSignedUrl: async () => 'https://signed.test/x' });
const purges = [];
fake(path.join(__dirname, '../server/placement/shield.js'), {
    enabled: (p) => p === 'b2',
    purge: async (args) => { purges.push([args.provider, args.key, args.size, typeof args.presign]); return { slices: 1, failed: 0 }; },
});

const storage = require('../server/vod/vod-storage');
(async () => {
    store['https://r2.test'].set('vods/6554.mp4', { size: 372516168 });
    store['https://b2.test'].set('vods/6554.mp4', { size: 371650766 });
    assert.deepStrictEqual(await storage.copyBetweenProviders('r2', 'b2', 'vods/6554.mp4'), { size: 372516168 });
    assert.strictEqual(store['https://b2.test'].get('vods/6554.mp4').size, 372516168, 'B2 holds R2\'s copy');
    assert.deepStrictEqual(purges, [['b2', 'vods/6554.mp4', 372516168, 'function']], 'the shield refreshed over the larger size');

    purges.length = 0;
    store['https://r2.test'].set('vods/7000.mp4', { size: 5000 });
    await storage.copyBetweenProviders('r2', 'b2', 'vods/7000.mp4');
    assert.deepStrictEqual(purges, [], 'a new key has nothing cached to refresh');
    store['https://b2.test'].set('vods/7001.mp4', { size: 6000 });
    store['https://r2.test'].set('vods/7001.mp4', { size: 10 });
    await storage.copyBetweenProviders('b2', 'r2', 'vods/7001.mp4');
    assert.deepStrictEqual(purges, [], 'R2 is not behind the shield');
    console.log('copy-refreshes-shield: a copy over a shielded key refreshes its slices');
})().catch((e) => { console.error(e); process.exit(1); });
