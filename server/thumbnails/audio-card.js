'use strict';
/**
 * OpenVibe.Media — the picture of an audio-only recording or clip.
 *
 * A browser broadcast with no camera is an Opus WebM (Media#240): there is no frame for ffmpeg to take, and the
 * thumbnail job used to answer `no_video` forever, so Live's cards and openvibe.video showed a hole. The picture is
 * made here instead, once: the streamer's avatar over a dark, softly blurred copy of it, with a small "Audio" mark.
 * It is stored like any thumbnail (/t/vod-<id>-<time>.jpg) and the item's row is marked audio_only, so nothing asks
 * Media again and the player knows it has no picture to show.
 *
 * The avatar is Media's own copy (an avatar object ingested from Network), found by the owner's app-local user id
 * (new avatars) or by the recording object's Network subject (old ones). Without one, a microphone on the same
 * gradient says the same thing.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const db = require('../db/database');

const WIDTH = 1280;
const HEIGHT = 720;
const AVATAR_PX = 320;
const AUDIO_MARK = '<path fill="currentColor" d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>';

const escapeXml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A local avatar file for an owner, preferring the avatar object's own bytes. */
async function avatarFile({ userId = null, objectId = null } = {}) {
    let subject = null;
    if (objectId) {
        try { subject = (await db.get('SELECT owner_subject FROM media_objects WHERE id = ?', [objectId]))?.owner_subject || null; } catch { /* older database */ }
    }
    const byUser = userId != null
        ? await db.all(`SELECT id, app_id, canonical_provider, canonical_key FROM media_objects
                        WHERE kind = 'avatar' AND lifecycle_status = 'ready' AND owner_user_id = ?
                        ORDER BY created_at DESC LIMIT 3`, [userId]).catch(() => [])
        : [];
    const bySubject = subject
        ? await db.all(`SELECT id, app_id, canonical_provider, canonical_key FROM media_objects
                        WHERE kind = 'avatar' AND lifecycle_status = 'ready' AND owner_subject = ?
                        ORDER BY created_at DESC LIMIT 3`, [subject]).catch(() => [])
        : [];
    const model = require('../objects/model');
    for (const obj of [...byUser, ...bySubject]) {
        const candidates = [obj.canonical_key, model.objectFilePath(obj)].filter(Boolean);
        for (const p of candidates) {
            try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch { /* unreadable: next */ }
        }
    }
    return null;
}

/** Break a title into at most two lines that fit the card. */
function titleLines(text, max = 44) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const lines = [];
    let line = '';
    for (const w of words) {
        const candidate = line ? `${line} ${w}` : w;
        if (candidate.length > max && line) { lines.push(line); line = w; } else line = candidate;
        if (lines.length === 2) break;
    }
    if (line && lines.length < 2) lines.push(line);
    if (lines.join(' ').length < String(text).trim().length) lines[1] = `${lines[1].replace(/[.,;:!?]?$/, '')}…`;
    return lines;
}

function backgroundSvg() {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/><stop offset="0.55" stop-color="#111a31"/><stop offset="1" stop-color="#1e1636"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="38%" r="62%">
      <stop offset="0" stop-color="#7c6cff" stop-opacity="0.28"/><stop offset="1" stop-color="#7c6cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <circle cx="640" cy="300" r="${AVATAR_PX / 2}" fill="#0b1020" opacity="0.55"/>
</svg>`);
}

function foregroundSvg({ title, hasAvatar }) {
    const lines = titleLines(title);
    const lineEls = lines.map((line, i) => `<text x="640" y="${548 + i * 54}" text-anchor="middle" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="42" font-weight="600" fill="#f4f6ff" opacity="0.94">${escapeXml(line)}</text>`).join('');
    const placeholder = hasAvatar ? '' : `<g transform="translate(560 140) scale(6.667)" color="#ffffff" opacity="0.62">${AUDIO_MARK}</g>`;
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  ${placeholder}
  <g transform="translate(64 56)">
    <rect width="156" height="58" rx="29" fill="#ffffff" opacity="0.10"/>
    <rect x="0.5" y="0.5" width="155" height="57" rx="28.5" fill="none" stroke="#ffffff" stroke-opacity="0.22"/>
    <g transform="translate(18 15) scale(1.15)" color="#ffffff" opacity="0.95">${AUDIO_MARK}</g>
    <text x="62" y="38" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="25" font-weight="600" fill="#ffffff" opacity="0.92">Audio</text>
  </g>
  ${lineEls}
  <text x="640" y="648" text-anchor="middle" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="23" fill="#c7cdea" opacity="0.72">Audio only · no picture was broadcast</text>
</svg>`);
}

/** Render the 1280×720 JPEG. `avatar` is a local image path, or null for the microphone. */
async function renderAudioCard({ title, avatar = null } = {}) {
    let avatarBuf = null;
    if (avatar) {
        try { avatarBuf = await sharp(avatar).rotate().resize(AVATAR_PX, AVATAR_PX, { fit: 'cover', position: 'attention' }).png().toBuffer(); } catch { avatarBuf = null; }
    }
    const base = avatarBuf
        ? await sharp(avatarBuf).resize(WIDTH, HEIGHT, { fit: 'cover' }).blur(46).modulate({ brightness: 0.42, saturation: 0.75 }).png().toBuffer()
        : await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#0a0e1a' } }).png().toBuffer();

    const layers = [{ input: backgroundSvg() }];
    if (avatarBuf) {
        const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_PX}" height="${AVATAR_PX}"><circle cx="${AVATAR_PX / 2}" cy="${AVATAR_PX / 2}" r="${AVATAR_PX / 2}" fill="#fff"/></svg>`);
        const round = await sharp(avatarBuf).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        layers.push({ input: round, left: (WIDTH - AVATAR_PX) / 2, top: 140 });
    }
    layers.push({ input: foregroundSvg({ title, hasAvatar: !!avatarBuf }) });
    return await sharp(base).composite(layers).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
}

/** Write the card as a timestamped thumbnail and return its public path, or null when it could not be made. */
async function writeAudioCard({ kind, id, title, userId = null, objectId = null }) {
    const avatar = await avatarFile({ userId, objectId });
    const buf = await renderAudioCard({ title, avatar });
    const filename = `${kind}-${id}-${Date.now()}.jpg`;
    const out = path.join(require('./thumbnail-service').THUMB_DIR, filename);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    return `/t/${filename}`;
}

module.exports = { writeAudioCard, renderAudioCard, avatarFile, titleLines, WIDTH, HEIGHT };
