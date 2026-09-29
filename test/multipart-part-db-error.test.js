'use strict';
// The part-completion listener read the session row (getSession) outside its try, so a rejected read
// was an unhandled rejection — Media installs no global handler — and the returned promise never
// settled, so the part request hung. The read now sits inside the try: a failure answers 500.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-mpdb-'));
    process.env.OBJECTS_PATH = path.join(tmp, 'objects');
    process.env.VOD_PATH = path.join(tmp, 'vods');
    process.env.FILES_PATH = path.join(tmp, 'files');
    process.env.THUMBNAILS_PATH = path.join(tmp, 'thumbs');

    const db = require('../server/db/database');
    const multipart = require('../server/objects/multipart');

    // A 1-part session of 4 bytes: the close listener hashes, checks the size, then reads the row.
    const session = { id: 'mup_test_dbdown', part_size: 4, total_size: 4, parts_expected: 1, status: 'active' };
    const origGet = db.get;
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    db.get = async () => { throw new Error('database is down'); };
    try {
        const req = new PassThrough();
        const p = multipart.receivePart(req, session, 1);
        req.end(Buffer.alloc(4, 7));
        const result = await Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), 3000))]);
        await new Promise((r) => setTimeout(r, 50)); // let a stray unhandled rejection surface
        assert.notStrictEqual(result, 'HUNG', 'the part request must settle when getSession rejects');
        assert.deepStrictEqual([result.status, result.code], [500, 'media.object.store_failed']);
        assert.strictEqual(unhandled, null, `unhandled rejection: ${unhandled && unhandled.message}`);
    } finally {
        db.get = origGet;
        process.off('unhandledRejection', onUnhandled);
    }

    console.log('✅ multipart part completion: a rejected getSession answers 500, no unhandled rejection and no hang');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
