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


/** One envelope → 'merged' | 'unchanged' | 'ignored:<why>'. */
async function apply(ev, { db = require('./db/database').getDb() } = {}) {
    if (!ev || ev.event_type !== TOPIC) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (!MERGE_RE.test(String(p.merge_id || '')) || !SUBJECT_RE.test(String(p.from || '')) || !SUBJECT_RE.test(String(p.into || '')) || p.from === p.into) return 'ignored:payload';
    return await db.tx(async () => {
        if (await db.prepare('SELECT 1 FROM subject_merges WHERE merge_id = ?').get(p.merge_id)) return 'unchanged';
        const objects = (await db.prepare('UPDATE media_objects SET owner_subject = ? WHERE owner_subject = ?').run(p.into, p.from)).changes;
        await db.prepare('INSERT INTO subject_merges (merge_id, from_subject, into_subject, objects) VALUES (?, ?, ?, ?)').run(p.merge_id, p.from, p.into, objects);
        console.log(`[Merge] ${p.merge_id}: ${objects} object(s) now owned by the survivor`);
        return 'merged';
    });
}

module.exports = { apply, TOPIC };
