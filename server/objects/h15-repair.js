'use strict';
/**
 * H15 repair (roadmap WS-G task 7): what to do with each ready object that has no good copy
 * (scripts/no-good-copy-report.js lists them). scripts/h15-repair.js runs it; this file holds the rules
 * and the writes, so they are tested without storage.
 *
 * Every copy is tried before anything is condemned:
 *
 *   rebaseline         a B2/R2 copy is "corrupt" only because its size differs from the size recorded
 *                      when the object was made (a recording's size captured mid-upload, no content
 *                      hash), and that copy decodes to the end with a real duration. The copy is the
 *                      object: size and sha256 are re-recorded from it and the location is present.
 *   failed_recording   the only bytes are a fragment (under MIN_SECONDS, or nothing decodes): the
 *                      recording failed when it was made, nothing was lost since. lifecycle_status
 *                      becomes 'failed', so readiness says not playable and public players hide it.
 *   regenerate         an AI-moment screenshot (ai-moment-vod<vod>-<seconds>.jpg) whose file is gone:
 *                      the same frame is extracted again from that VOD's good copy and written back.
 *   lost               nothing above applies: reported for the owner, nothing written.
 *
 * Writes happen only in apply(), each object in its own transaction and only while the row still holds
 * what was read (so a concurrent change wins); every change is returned with its old values for the
 * rollback file.
 */
const MIN_SECONDS = 2;
const BENIGN = /non monotonically increasing dts|Last message repeated/i;
const SHOT_RE = /ai-moment-vod(\d+)-(\d+)\.jpg$/;

/** The decode verdict of one copy: { duration, streams, errorLines } → { ok, reason } */
function judgeProbe(p) {
    if (!p || p.error) return { ok: false, reason: `unreadable: ${(p && p.error) || 'no probe'}` };
    if (!p.streams || !p.streams.length) return { ok: false, reason: 'no audio or video stream' };
    const serious = (p.errorLines || []).filter((l) => l.trim() && !BENIGN.test(l));
    if (serious.length > 5) return { ok: false, reason: `${serious.length} decode errors (first: ${serious[0].slice(0, 120)})` };
    if (!(p.duration >= MIN_SECONDS)) return { ok: false, fragment: true, reason: `only ${Number(p.duration || 0).toFixed(1)} s decode` };
    return { ok: true, reason: `decodes to the end: ${p.duration.toFixed(1)} s, ${p.streams.join('+')}${serious.length ? `, ${serious.length} minor decode error(s)` : ''}` };
}

/**
 * The plan for one report item. probes: provider → probe of that copy (only for corrupt remote copies).
 * → { object_id, action, provider?, reason, source_vod?, offset? }
 */
function plan(item, probes = {}) {
    // What the plan was based on: apply() writes only while the row still holds it.
    const base = { object_id: item.object_id, kind: item.kind, legacy_ref: item.legacy_ref || null, read: { size_bytes: item.size_bytes, content_hash: item.content_hash || null, lifecycle_status: 'ready' } };
    const shot = item.kind === 'screenshot' && (item.locations || []).map((l) => SHOT_RE.exec(String(l.key || ''))).find(Boolean);
    if (shot && (item.locations || []).every((l) => l.state === 'missing')) {
        return { ...base, action: 'regenerate', source_vod: Number(shot[1]), offset: Number(shot[2]), reason: `the frame at ${shot[2]} s of VOD ${shot[1]} can be extracted again` };
    }
    const remote = (item.locations || []).filter((l) => (l.provider === 'b2' || l.provider === 'r2') && l.state === 'corrupt');
    if (remote.length && !item.content_hash) {
        let fragment = null;
        for (const l of remote) {
            const v = judgeProbe(probes[l.provider]);
            if (v.ok) return { ...base, action: 'rebaseline', provider: l.provider, key: l.key, reason: `${l.provider} copy ${v.reason}; only its size differed from the size recorded at creation (${item.size_bytes} bytes)` };
            if (v.fragment) fragment = { provider: l.provider, reason: v.reason };
        }
        if (fragment) return { ...base, action: 'failed_recording', provider: fragment.provider, reason: `the only copy is a fragment (${fragment.reason}): the recording failed when it was made` };
    }
    return { ...base, action: 'lost', reason: 'no copy decodes and nothing can regenerate it' };
}

/**
 * Apply one planned change. h = better-sqlite3 handle. facts: { size, sha256 } of the good bytes (rebaseline,
 * regenerate). → the change with old values, or { skipped } when the row moved on.
 */
function apply(h, step, facts = {}) {
    const cur = h.prepare('SELECT id, size_bytes, content_hash, lifecycle_status FROM media_objects WHERE id = ?').get(step.object_id);
    if (!cur) return { ...step, skipped: 'object gone' };
    const obj = { ...cur, ...(step.read || {}) };
    const tx = h.transaction(() => {
        if (step.action === 'rebaseline' || step.action === 'regenerate') {
            const provider = step.action === 'regenerate' ? 'local' : step.provider;
            const loc = h.prepare('SELECT id, state, size_bytes FROM media_locations WHERE object_id = ? AND provider = ?').get(obj.id, provider);
            if (!loc) return { ...step, skipped: `no ${provider} location` };
            const r = h.prepare("UPDATE media_objects SET size_bytes = ?, content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND size_bytes IS ? AND content_hash IS ?")
                .run(facts.size, facts.sha256, obj.id, obj.size_bytes, obj.content_hash);
            if (!r.changes) return { ...step, skipped: 'the object changed since it was read' };
            h.prepare("UPDATE media_locations SET state = 'present', size_bytes = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(facts.size, loc.id);
            return { ...step, old: { size_bytes: obj.size_bytes, content_hash: obj.content_hash, location_state: loc.state, location_size: loc.size_bytes }, new: { size_bytes: facts.size, content_hash: facts.sha256, location_state: 'present' } };
        }
        if (step.action === 'failed_recording') {
            const r = h.prepare("UPDATE media_objects SET lifecycle_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lifecycle_status = ?").run(obj.id, obj.lifecycle_status);
            if (!r.changes) return { ...step, skipped: 'the object changed since it was read' };
            return { ...step, old: { lifecycle_status: obj.lifecycle_status }, new: { lifecycle_status: 'failed' } };
        }
        return { ...step, skipped: 'nothing to write' };
    });
    return tx();
}

/** Undo one applied change where the row still holds what the repair wrote. → { restored } | { skipped } */
function rollback(h, change) {
    if (!change || !change.old || !change.new) return { ...change, skipped: 'not an applied change' };
    const tx = h.transaction(() => {
        if (change.action === 'failed_recording') {
            const r = h.prepare('UPDATE media_objects SET lifecycle_status = ? WHERE id = ? AND lifecycle_status = ?').run(change.old.lifecycle_status, change.object_id, change.new.lifecycle_status);
            return r.changes ? { ...change, restored: true } : { ...change, skipped: 'the row changed since' };
        }
        const r = h.prepare('UPDATE media_objects SET size_bytes = ?, content_hash = ? WHERE id = ? AND size_bytes IS ? AND content_hash IS ?')
            .run(change.old.size_bytes, change.old.content_hash, change.object_id, change.new.size_bytes, change.new.content_hash);
        if (!r.changes) return { ...change, skipped: 'the row changed since' };
        const provider = change.action === 'regenerate' ? 'local' : change.provider;
        h.prepare('UPDATE media_locations SET state = ?, size_bytes = ? WHERE object_id = ? AND provider = ?').run(change.old.location_state, change.old.location_size, change.object_id, provider);
        return { ...change, restored: true };
    });
    return tx();
}

module.exports = { plan, apply, rollback, judgeProbe, MIN_SECONDS, SHOT_RE };
