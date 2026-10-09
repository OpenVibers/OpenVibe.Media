'use strict';
/**
 * Content-Disposition for an object download. A stored filename can be anything a person named a file
 * (legacy files keep their original_name, derive jobs pass metadata through), and Node refuses a header
 * value outside Latin-1, so the header carries a printable-ASCII fallback in filename= and the real name,
 * percent-encoded as UTF-8, in filename*= (RFC 6266 / RFC 5987): 日本.pdf downloads as 日本.pdf.
 */

/** Printable ASCII only, quotes and backslashes replaced: the filename= fallback. */
function asciiName(name) {
    return String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 200) || 'file';
}

/** RFC 5987 ext-value: UTF-8, percent-encoded, with the characters encodeURIComponent leaves but attr-char refuses. */
function extValue(name) {
    return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The header value: `inline` or `attachment`, the fallback, and filename*= only when the fallback lost
 * something. Control characters (CR, LF and the rest) never reach the header in either form.
 */
function contentDisposition(name, { inline = false } = {}) {
    const real = Array.from(String(name == null || name === '' ? 'file' : name).replace(/[\u0000-\u001f\u007f]/g, '_')).slice(0, 200).join('') || 'file';
    const fallback = asciiName(real);
    const kind = inline ? 'inline' : 'attachment';
    return fallback === real ? `${kind}; filename="${fallback}"` : `${kind}; filename="${fallback}"; filename*=UTF-8''${extValue(real)}`;
}

module.exports = { contentDisposition, asciiName };
