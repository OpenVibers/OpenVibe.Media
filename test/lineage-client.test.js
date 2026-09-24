'use strict';
/** Media asks Live's canonical lineage resolver (D20) for a channel, with its service token; no mapping of its own. */
const assert = require('assert');
const { createLineageClient } = require('../server/lineage-client');

(async () => {
    const asked = [];
    let answer = { status: 'resolved', channel: { id: '17', slug: 'Goosely', owner_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', legacy_ids: { live_user_id: 5 } }, rule: 'slug' };
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
        if (u.pathname === '/oauth/token') return reply(200, { access_token: 'svc-media', token_type: 'Bearer', expires_in: 300, scope: 'live.lineage.resolve' });
        asked.push({ path: u.pathname, slug: u.searchParams.get('slug'), auth: opts.headers.Authorization });
        return typeof answer === 'number' ? reply(answer, {}) : reply(200, answer);
    };
    const c = createLineageClient({ liveUrl: 'http://live.test', networkUrl: 'http://net.test', clientSecret: 'media-secret-for-tests', fetchImpl });
    assert.deepStrictEqual(await c.channelBySlug('goosely'), { slug: 'Goosely', live_user_id: 5, owner_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' });
    assert.deepStrictEqual(asked, [{ path: '/internal/lineage/resolve', slug: 'goosely', auth: 'Bearer svc-media' }]);
    answer = { status: 'unresolved', reason: 'no_match' };
    assert.strictEqual(await c.channelBySlug('nobody'), null, 'unresolved is an answer, not an error');
    assert.strictEqual(await c.channelBySlug('../etc'), null, 'not a slug: never sent');
    assert.strictEqual(asked.length, 2);
    answer = 503;
    await assert.rejects(c.channelBySlug('goosely'), /answered 503/, 'Live down: the caller falls back');
    const off = createLineageClient({ clientSecret: '', fetchImpl });
    assert.strictEqual(off.enabled, false);
    await assert.rejects(off.channelBySlug('goosely'), /off/);
    console.log('lineage client: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
