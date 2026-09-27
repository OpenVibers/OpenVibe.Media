'use strict';
/**
 * network.subject.merged → Media (roadmap WS-B task 5, ADR-029; Contracts 0.69.0). Two Network accounts became one:
 * `from` is an alias of `into`. Media repoints what it owns by subject: media_objects.owner_subject from `from` to
 * `into`, in one transaction, once per merge_id (subject_merges). VOD and clip rows name Live's user ids, which Live's
 * own consumer handles. Arrives at POST /internal/events (server/revocations.js), signed and loopback-only.
 */
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MERGE_RE = /^mrg_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOPIC = 'network.subject.merged';

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS subject_merges (
        merge_id     TEXT PRIMARY KEY,
        from_subject TEXT NOT NULL,
        into_subject TEXT NOT NULL,
        objects      INTEGER NOT NULL DEFAULT 0,
        applied_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
}

/** One envelope → 'merged' | 'unchanged' | 'ignored:<why>'. */
function apply(ev, { db = require('./db/database').getDb() } = {}) {
    if (!ev || ev.event_type !== TOPIC) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (!MERGE_RE.test(String(p.merge_id || '')) || !SUBJECT_RE.test(String(p.from || '')) || !SUBJECT_RE.test(String(p.into || '')) || p.from === p.into) return 'ignored:payload';
    ensureSchema(db);
    return db.transaction(() => {
        if (db.prepare('SELECT 1 FROM subject_merges WHERE merge_id = ?').get(p.merge_id)) return 'unchanged';
        const objects = db.prepare('UPDATE media_objects SET owner_subject = ? WHERE owner_subject = ?').run(p.into, p.from).changes;
        db.prepare('INSERT INTO subject_merges (merge_id, from_subject, into_subject, objects) VALUES (?, ?, ?, ?)').run(p.merge_id, p.from, p.into, objects);
        console.log(`[Merge] ${p.merge_id}: ${objects} object(s) now owned by the survivor`);
        return 'merged';
    })();
}

module.exports = { apply, ensureSchema, TOPIC };
