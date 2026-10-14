'use strict';
/**
 * AWS Signature Version 4 for Media's S3 surface (ADR-031): the server half. Media holds each access key's secret
 * (server/s3/keys.js) and recomputes the signature a client made, the way S3 does.
 *
 *   parse(req)                     → { kind: 'header'|'presigned', accessKeyId, date, amzDate, region, scope,
 *                                      signedHeaders, signature, payloadHash, expires } | { error }
 *   verify(req, parsed, secret, { now })   → null | { code, message }   (the S3 error to answer)
 *   chunkDecoder(parsed, secret)   → a Transform that turns an aws-chunked body into its bytes, checking every chunk
 *                                    signature (STREAMING-AWS4-HMAC-SHA256-PAYLOAD[-TRAILER]) and reading the trailers
 *
 * Canonical forms follow S3, not the generic SigV4 rules: the path is decoded and encoded again exactly once, with
 * '/' kept, and is never normalised (S3 keys may hold '..', '//' and spaces). Header-signed requests must be within
 * 15 minutes of now; a presigned URL may live 7 days at most and may not be signed more than 15 minutes ahead.
 */
const crypto = require('crypto');
const { Transform } = require('stream');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const MAX_PRESIGN_S = 7 * 24 * 3600;
const SKEW_MS = 15 * 60 * 1000;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const STREAMING = new Set([
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
    'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
    'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
]);

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding as AWS uses it: everything but A-Z a-z 0-9 - . _ ~ is %XX (upper case hex). */
function awsEncode(s, keepSlash = false) {
    let out = '';
    for (const b of Buffer.from(String(s), 'utf8')) {
        const c = String.fromCharCode(b);
        if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
        else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
}

/** decodeURIComponent that leaves a malformed escape alone instead of throwing. */
function safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return s; }
}

/** The path as S3 canonicalises it: each segment decoded, then encoded once; '/' kept; nothing normalised. */
function canonicalPath(rawPath) {
    return String(rawPath || '/').split('/').map((seg) => awsEncode(safeDecode(seg))).join('/') || '/';
}

/** [name, value] pairs of a raw query string, decoded ('+' is a space only in form encoding, never here). */
function queryPairs(rawQuery) {
    if (!rawQuery) return [];
    return rawQuery.split('&').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return i < 0 ? [safeDecode(p), ''] : [safeDecode(p.slice(0, i)), safeDecode(p.slice(i + 1))];
    });
}

function canonicalQuery(pairs) {
    return pairs.map(([k, v]) => [awsEncode(k), awsEncode(v)])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`).join('&');
}

function headerValue(req, name) {
    const v = req.headers[name];
    if (v === undefined) return undefined;
    return (Array.isArray(v) ? v.join(',') : String(v)).trim().replace(/\s+/g, ' ');
}

function splitUrl(req) {
    const raw = req.originalUrl || req.url || '/';
    const q = raw.indexOf('?');
    return { path: q < 0 ? raw : raw.slice(0, q), query: q < 0 ? '' : raw.slice(q + 1) };
}

/** The path the client signed: the request path below the router's mount point (req.baseUrl), as sent. */
function signedPath(req) {
    const { path } = splitUrl(req);
    const base = req.baseUrl || '';
    return base && path.startsWith(base) ? path.slice(base.length) || '/' : path;
}

function signingKey(secret, date, region, service) {
    return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** Read the credentials a request carries (header or presigned query). Nothing is verified here. */
function parse(req) {
    const auth = headerValue(req, 'authorization');
    const { query } = splitUrl(req);
    const pairs = queryPairs(query);
    const q = Object.fromEntries(pairs);
    if (auth && auth.startsWith(`${ALGORITHM} `)) {
        const fields = Object.fromEntries(auth.slice(ALGORITHM.length + 1).split(',').map((f) => {
            const i = f.indexOf('=');
            return i < 0 ? [f.trim(), ''] : [f.slice(0, i).trim(), f.slice(i + 1).trim()];
        }));
        const cred = String(fields.Credential || '').split('/');
        if (cred.length !== 5 || cred[4] !== 'aws4_request' || !fields.SignedHeaders || !/^[0-9a-f]{64}$/.test(fields.Signature || '')) {
            return { error: { code: 'AuthorizationHeaderMalformed', message: 'The authorization header is malformed' } };
        }
        const amzDate = headerValue(req, 'x-amz-date');
        const payloadHash = headerValue(req, 'x-amz-content-sha256');
        if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate)) return { error: { code: 'AccessDenied', message: 'X-Amz-Date is required' } };
        if (!payloadHash) return { error: { code: 'InvalidRequest', message: 'Missing required header for this request: x-amz-content-sha256' } };
        return {
            kind: 'header', accessKeyId: cred[0], date: cred[1], region: cred[2], service: cred[3], amzDate,
            scope: cred.slice(1).join('/'), signedHeaders: fields.SignedHeaders.split(';'), signature: fields.Signature,
            payloadHash, pairs,
        };
    }
    if (q['X-Amz-Algorithm'] !== undefined) {
        if (q['X-Amz-Algorithm'] !== ALGORITHM) return { error: { code: 'AuthorizationQueryParametersError', message: 'X-Amz-Algorithm must be AWS4-HMAC-SHA256' } };
        const cred = String(q['X-Amz-Credential'] || '').split('/');
        const expires = Number(q['X-Amz-Expires']);
        if (cred.length !== 5 || cred[4] !== 'aws4_request' || !/^\d{8}T\d{6}Z$/.test(q['X-Amz-Date'] || '')
            || !q['X-Amz-SignedHeaders'] || !/^[0-9a-f]{64}$/.test(q['X-Amz-Signature'] || '')) {
            return { error: { code: 'AuthorizationQueryParametersError', message: 'The presigned URL is malformed' } };
        }
        if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_S) {
            return { error: { code: 'AuthorizationQueryParametersError', message: 'X-Amz-Expires must be between 1 and 604800 seconds' } };
        }
        return {
            kind: 'presigned', accessKeyId: cred[0], date: cred[1], region: cred[2], service: cred[3], amzDate: q['X-Amz-Date'],
            scope: cred.slice(1).join('/'), signedHeaders: String(q['X-Amz-SignedHeaders']).split(';'), signature: q['X-Amz-Signature'],
            payloadHash: 'UNSIGNED-PAYLOAD', expires, pairs: pairs.filter(([k]) => k !== 'X-Amz-Signature'),
        };
    }
    return { error: null, anonymous: true };
}

function amzDateMs(amzDate) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/** The signature the client should have sent, given the secret. */
function expectedSignature(req, parsed, secret) {
    const headers = parsed.signedHeaders.map((h) => {
        const v = h === 'host' ? (headerValue(req, 'host') || '') : headerValue(req, h);
        return `${h}:${v === undefined ? '' : v}\n`;
    }).join('');
    const canonical = [
        req.method,
        canonicalPath(signedPath(req)),
        canonicalQuery(parsed.pairs),
        headers,
        parsed.signedHeaders.join(';'),
        parsed.payloadHash,
    ].join('\n');
    const toSign = [ALGORITHM, parsed.amzDate, parsed.scope, sha256hex(canonical)].join('\n');
    const key = signingKey(secret, parsed.date, parsed.region, parsed.service);
    return { signature: crypto.createHmac('sha256', key).update(toSign, 'utf8').digest('hex'), key };
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** null when the request is signed by `secret` and in time; else the S3 error ({ code, message }). */
function verify(req, parsed, secret, { now = Date.now() } = {}) {
    if (parsed.service !== 's3') return { code: 'AuthorizationHeaderMalformed', message: 'The credential scope must name the s3 service' };
    if (parsed.amzDate.slice(0, 8) !== parsed.date) return { code: 'AuthorizationHeaderMalformed', message: 'The credential date does not match X-Amz-Date' };
    if (!parsed.signedHeaders.includes('host')) return { code: 'AccessDenied', message: 'The host header must be signed' };
    const at = amzDateMs(parsed.amzDate);
    if (!Number.isFinite(at)) return { code: 'AccessDenied', message: 'X-Amz-Date is not a date' };
    if (parsed.kind === 'header' && Math.abs(now - at) > SKEW_MS) {
        return { code: 'RequestTimeTooSkewed', message: 'The difference between the request time and the current time is too large' };
    }
    if (parsed.kind === 'presigned') {
        if (at - now > SKEW_MS) return { code: 'AccessDenied', message: 'Request is not valid yet' };
        if (now > at + parsed.expires * 1000) return { code: 'AccessDenied', message: 'Request has expired' };
    }
    const { signature, key } = expectedSignature(req, parsed, secret);
    if (!safeEqual(signature, parsed.signature)) {
        return { code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided' };
    }
    parsed.signingKey = key;
    return null;
}

/** Is the payload an aws-chunked stream (x-amz-content-sha256 says so)? */
function isStreaming(parsed) {
    return STREAMING.has(parsed.payloadHash);
}

/**
 * aws-chunked → bytes. Each chunk is `<hex size>[;chunk-signature=<sig>]\r\n<data>\r\n`, ending with a 0-size chunk,
 * then (for the -TRAILER forms) `name:value\r\n` trailers and, when signed, `x-amz-trailer-signature:<sig>\r\n`, and
 * a final `\r\n`. Signed chunks chain from the request's seed signature. The trailers are handed to `onTrailers` as
 * an object (x-amz-checksum-* values are checked by the caller). Errors are emitted with an S3 `code`.
 */
function chunkDecoder(parsed, { onTrailers = () => {} } = {}) {
    const signed = parsed.payloadHash.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD');
    const scope = parsed.scope;
    let prev = parsed.signature;
    let buf = Buffer.alloc(0);
    let state = 'header';          // header → data → crlf → … → trailers → done
    let want = 0, chunkSig = null, chunkHash = null, trailerSigned = false;
    const trailers = {};
    const fail = (self, code, message) => { const e = new Error(message); e.code = code; self.destroy(e); };
    const sigOk = (stringToSign, sig) => safeEqual(crypto.createHmac('sha256', parsed.signingKey).update(stringToSign, 'utf8').digest('hex'), sig);

    return new Transform({
        transform(chunk, _enc, cb) {
            buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
            try {
                for (;;) {
                    if (state === 'header') {
                        const i = buf.indexOf('\r\n');
                        if (i < 0) { if (buf.length > 4096) return fail(this, 'IncompleteBody', 'Malformed chunk header'); break; }
                        const line = buf.slice(0, i).toString('latin1');
                        buf = buf.slice(i + 2);
                        const [sizeHex, ...ext] = line.split(';');
                        if (!/^[0-9a-fA-F]{1,16}$/.test(sizeHex)) return fail(this, 'IncompleteBody', 'Malformed chunk size');
                        want = parseInt(sizeHex, 16);
                        const sigExt = ext.find((e) => e.startsWith('chunk-signature='));
                        chunkSig = sigExt ? sigExt.slice('chunk-signature='.length) : null;
                        if (signed && !/^[0-9a-f]{64}$/.test(chunkSig || '')) return fail(this, 'SignatureDoesNotMatch', 'A chunk carries no signature');
                        chunkHash = crypto.createHash('sha256');
                        state = want === 0 ? 'last' : 'data';
                    } else if (state === 'data') {
                        if (!buf.length) break;
                        const take = Math.min(want, buf.length);
                        const part = buf.slice(0, take);
                        buf = buf.slice(take);
                        want -= take;
                        chunkHash.update(part);
                        this.push(part);
                        if (want === 0) state = 'crlf';
                    } else if (state === 'crlf') {
                        if (buf.length < 2) break;
                        if (buf[0] !== 13 || buf[1] !== 10) return fail(this, 'IncompleteBody', 'Malformed chunk terminator');
                        buf = buf.slice(2);
                        if (signed) {
                            const s = ['AWS4-HMAC-SHA256-PAYLOAD', parsed.amzDate, scope, prev, EMPTY_SHA256, chunkHash.digest('hex')].join('\n');
                            if (!sigOk(s, chunkSig)) return fail(this, 'SignatureDoesNotMatch', 'A chunk signature does not match');
                            prev = chunkSig;
                        }
                        state = 'header';
                    } else if (state === 'last') {
                        if (signed) {
                            const s = ['AWS4-HMAC-SHA256-PAYLOAD', parsed.amzDate, scope, prev, EMPTY_SHA256, EMPTY_SHA256].join('\n');
                            if (!sigOk(s, chunkSig)) return fail(this, 'SignatureDoesNotMatch', 'The final chunk signature does not match');
                            prev = chunkSig;
                        }
                        state = 'trailers';
                    } else if (state === 'trailers') {
                        const i = buf.indexOf('\r\n');
                        if (i < 0) { if (buf.length > 8192) return fail(this, 'IncompleteBody', 'Malformed trailers'); break; }
                        const line = buf.slice(0, i).toString('latin1');
                        buf = buf.slice(i + 2);
                        if (line === '') { state = 'done'; continue; }
                        const c = line.indexOf(':');
                        if (c < 0) return fail(this, 'IncompleteBody', 'Malformed trailer');
                        const name = line.slice(0, c).trim().toLowerCase(), value = line.slice(c + 1).trim();
                        if (name === 'x-amz-trailer-signature') {
                            const body = Object.entries(trailers).map(([k, v]) => `${k}:${v}\n`).join('');
                            const s = ['AWS4-HMAC-SHA256-TRAILER', parsed.amzDate, scope, prev, sha256hex(body)].join('\n');
                            if (!sigOk(s, value)) return fail(this, 'SignatureDoesNotMatch', 'The trailer signature does not match');
                            trailerSigned = true;
                        } else trailers[name] = value;
                    } else break;
                }
                cb();
            } catch (e) { cb(e); }
        },
        flush(cb) {
            // A body that ends right after the 0-size chunk (no trailers, no final CRLF) is complete too.
            if (state !== 'done' && !(state === 'trailers' && buf.length === 0)) {
                const e = new Error('The request body ended early'); e.code = 'IncompleteBody'; return cb(e);
            }
            if (signed && parsed.payloadHash.endsWith('-TRAILER') && Object.keys(trailers).length && !trailerSigned) {
                const e = new Error('Trailers are not signed'); e.code = 'SignatureDoesNotMatch'; return cb(e);
            }
            onTrailers(trailers);
            cb();
        },
    });
}

module.exports = {
    parse, verify, isStreaming, chunkDecoder, awsEncode, canonicalPath, canonicalQuery, queryPairs, signingKey,
    expectedSignature, signedPath, EMPTY_SHA256, MAX_PRESIGN_S, SKEW_MS,
};
