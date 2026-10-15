'use strict';
// server/s3/sigv4.js against the worked examples of the Amazon S3 API reference ("Signature Calculations for the
// Authorization Header", "Authenticating Requests: Using Query Parameters" and "Signature Calculations for the
// Authorization Header: Transferring Payload in Multiple Chunks"), with their published signatures. They pin the
// canonical forms independently of any SDK: the path, the query, the signed headers and the chunk signature chain.
const assert = require('assert');
const { Readable } = require('stream');
const sigv4 = require('../server/s3/sigv4');

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AT = Date.UTC(2013, 4, 24, 0, 0, 30);
const req = (method, url, headers) => ({ method, url, originalUrl: url, baseUrl: '', headers });

(async () => {
    // GET Object with a Range, signed in the Authorization header.
    let r = req('GET', '/test.txt', {
        host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
        'x-amz-content-sha256': sigv4.EMPTY_SHA256, 'x-amz-date': '20130524T000000Z',
        authorization: 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    });
    let p = sigv4.parse(r);
    assert.strictEqual(p.kind, 'header');
    assert.strictEqual(sigv4.verify(r, p, SECRET, { now: AT }), null, 'the published GET Object signature verifies');
    assert.strictEqual(sigv4.verify(r, p, 'x'.repeat(40), { now: AT }).code, 'SignatureDoesNotMatch');
    assert.strictEqual(sigv4.verify(r, p, SECRET, { now: AT + 20 * 60 * 1000 }).code, 'RequestTimeTooSkewed', 'header-signed requests are good for 15 minutes');

    // A presigned GET (query parameters), valid 86400 seconds.
    const q = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host';
    r = req('GET', `/test.txt?${q}&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`, { host: 'examplebucket.s3.amazonaws.com' });
    p = sigv4.parse(r);
    assert.deepStrictEqual([p.kind, p.expires, p.payloadHash], ['presigned', 86400, 'UNSIGNED-PAYLOAD']);
    assert.strictEqual(sigv4.verify(r, p, SECRET, { now: AT }), null, 'the published presigned URL verifies');
    assert.strictEqual(sigv4.verify(r, p, SECRET, { now: AT + 86401 * 1000 }).message, 'Request has expired');
    r = req('GET', `/test.txt?${q.replace('86400', '604801')}&X-Amz-Signature=${'0'.repeat(64)}`, { host: 'examplebucket.s3.amazonaws.com' });
    assert.strictEqual(sigv4.parse(r).error.code, 'AuthorizationQueryParametersError', 'a presigned URL lives 7 days at most');

    // A chunked upload: 66560 bytes of 'a' in chunks of 65536, 1024 and 0, each signature chained to the last.
    const headers = {
        host: 's3.amazonaws.com', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', 'content-encoding': 'aws-chunked',
        'x-amz-decoded-content-length': '66560', 'content-length': '66824',
        authorization: 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=content-encoding;content-length;host;x-amz-content-sha256;x-amz-date;x-amz-decoded-content-length;x-amz-storage-class,Signature=4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9',
    };
    r = req('PUT', '/examplebucket/chunkObject.txt', headers);
    p = sigv4.parse(r);
    assert.strictEqual(sigv4.verify(r, p, SECRET, { now: AT }), null, 'the published seed signature verifies');
    assert.ok(sigv4.isStreaming(p));
    const chunk = (n, sig) => Buffer.concat([Buffer.from(`${n.toString(16)};chunk-signature=${sig}\r\n`), Buffer.alloc(n, 'a'), Buffer.from('\r\n')]);
    const body = Buffer.concat([
        chunk(65536, 'ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648'),
        chunk(1024, '0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497'),
        chunk(0, 'b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9'),
    ]);
    assert.strictEqual(body.length, 66824, 'the published body length');
    const decode = async (bytes, parsed) => {
        const out = [];
        for await (const c of Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000, 40000), bytes.subarray(40000)]).pipe(sigv4.chunkDecoder(parsed))) out.push(c);
        return Buffer.concat(out);
    };
    const data = await decode(body, p);
    assert.ok(data.equals(Buffer.alloc(66560, 'a')), 'the chunks decode to the 66560 bytes, every signature checked');
    const tampered = Buffer.from(body);
    tampered[200] = 'b'.charCodeAt(0);
    await assert.rejects(decode(tampered, p), (e) => e.code === 'SignatureDoesNotMatch', 'a changed byte breaks its chunk signature');
    await assert.rejects(decode(body.subarray(0, 66000), p), (e) => e.code === 'IncompleteBody', 'a truncated body is refused');

    // Canonical paths: decoded once, encoded once, '/' kept, nothing normalised.
    assert.strictEqual(sigv4.canonicalPath('/bucket/a%20b%2Bc/..//x~y'), '/bucket/a%20b%2Bc/..//x~y');
    assert.strictEqual(sigv4.canonicalPath('/bucket/caf%C3%A9'), '/bucket/caf%C3%A9');
    console.log('s3 sigv4: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
