#!/usr/bin/env node
'use strict';
/**
 * Export an app's pastes, comments and likes as a canonical bundle for OpenVibe.Community's importer
 * (roadmap Wave 5: Community becomes the paste authority; Media keeps only the screenshot bytes).
 *
 *   node scripts/export-pastes.js --app live --out /tmp/pastes.json [--since-id N] [--db ./data/media.db]
 *
 * Read-only (opens the database readonly). Deterministic for the same data: rows ordered by id, keys
 * in a fixed order, sha256 over { pastes, comments, likes }. IP addresses are never exported.
 * --since-id exports pastes with id > N plus every comment/like on any paste (they are small and the
 * importer upserts them), so an incremental run after cutover catches late writes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const app = arg('app', 'live');
const out = arg('out');
const sinceId = Number(arg('since-id', 0)) || 0;
const dbPath = path.resolve(arg('db', process.env.DB_PATH || './data/media.db'));
const publicBase = String(process.env.MEDIA_PUBLIC_URL || 'https://openvibe.media').replace(/\/$/, '');
if (!out) { console.error('usage: export-pastes.js --app <id> --out <file> [--since-id N] [--db path]'); process.exit(2); }

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const json = (s) => { if (s == null || s === '') return null; try { return JSON.parse(s); } catch { return null; } };
const tags = (s) => { const v = json(s); return Array.isArray(v) ? v : (typeof s === 'string' && s ? s.split(',').map(x => x.trim()).filter(Boolean) : null); };

const pastes = db.prepare(`SELECT * FROM pastes WHERE app_id = ? AND id > ? ORDER BY id`).all(app, sinceId).map(p => ({
    id: p.id, slug: p.slug, user_id: p.user_id, type: p.type, title: p.title, content: p.content, language: p.language,
    visibility: p.visibility, stream_id: p.stream_id,
    screenshot_url: p.screenshot_path ? `${publicBase}/p/${p.slug}/screenshot` : null,
    metadata: json(p.metadata), burn_after_read: p.burn_after_read, forked_from: p.forked_from, pinned: p.pinned,
    views: p.views, unique_views: p.unique_views || 0, copies: p.copies, likes: p.likes, is_nsfw: p.is_nsfw,
    ai_summary: p.ai_summary, ai_tags: tags(p.ai_tags), ai_analyzed_at: p.ai_analyzed_at,
    created_at: p.created_at, updated_at: p.updated_at,
}));
const comments = db.prepare(`SELECT c.* FROM paste_comments c JOIN pastes p ON p.id = c.paste_id WHERE p.app_id = ? ORDER BY c.id`).all(app).map(c => ({
    id: c.id, paste_id: c.paste_id, user_id: c.user_id, parent_id: c.parent_id, anon_name: c.anon_name,
    message: c.message, is_deleted: c.is_deleted, created_at: c.created_at, updated_at: c.updated_at,
}));
const likes = db.prepare(`SELECT l.* FROM paste_likes l JOIN pastes p ON p.id = l.paste_id WHERE p.app_id = ? ORDER BY l.paste_id, l.user_id`).all(app).map(l => ({
    paste_id: l.paste_id, user_id: l.user_id, created_at: l.created_at,
}));
db.close();

const body = { pastes, comments, likes };
const bundle = {
    format: 'openvibe.media.pastes-export', version: 1, app,
    generated_at: new Date().toISOString(), since_id: sinceId,
    max_id: pastes.length ? pastes[pastes.length - 1].id : sinceId,
    sha256: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    counts: { pastes: pastes.length, comments: comments.length, likes: likes.length },
    ...body,
};
fs.writeFileSync(out, JSON.stringify(bundle));
fs.chmodSync(out, 0o600);   // paste content can be private/unlisted
console.log(JSON.stringify({ out, app, since_id: sinceId, max_id: bundle.max_id, counts: bundle.counts, sha256: bundle.sha256 }));
