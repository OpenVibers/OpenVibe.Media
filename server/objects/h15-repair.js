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
 *   resize             a B2/R2 copy is "corrupt" but its bytes hash to the object's own content_hash: the
 *                      bytes are exactly the object and only its recorded size is wrong. That happened
 *                      after the 2026-09-25 rebaseline, when a projection from the legacy vods row
 *                      (server/objects/model.js vodProjection, file_size) put the mid-upload size back
 *                      and kept the hash. The size is re-recorded from the copy.
 *
 * rebaseline and resize also write the size to the legacy vods row behind the object (legacy_ref
 * legacy:<app>:vod:<id>, file_size), so the projection agrees with the object and cannot undo it.
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
const VOD_REF = /^legacy:[\w-]+:vod:(\d+)$/;

function plan(item, probes = {}, facts = {}) {
    // What the plan was based on: apply() writes only while the row still holds it.
    const base = { object_id: item.object_id, kind: item.kind, legacy_ref: item.legacy_ref || null, read: { size_bytes: item.size_bytes, content_hash: item.content_hash || null, lifecycle_status: 'ready' } };
    const shot = item.kind === 'screenshot' && (item.locations || []).map((l) => SHOT_RE.exec(String(l.key || ''))).find(Boolean);
    if (shot && (item.locations || []).every((l) => l.state === 'missing')) {
        return { ...base, action: 'regenerate', source_vod: Number(shot[1]), offset: Number(shot[2]), reason: `the frame at ${shot[2]} s of VOD ${shot[1]} can be extracted again` };
    }
    const remote = (item.locations || []).filter((l) => (l.provider === 'b2' || l.provider === 'r2') && l.state === 'corrupt');
    // facts: provider → { size, sha256 } of the downloaded copy. Bytes that hash to the recorded hash are the object.
    for (const l of item.content_hash ? remote : []) {
        const f = facts[l.provider];
        if (f && f.sha256 === item.content_hash && f.size !== item.size_bytes) {
            return { ...base, action: 'resize', provider: l.provider, key: l.key, reason: `${l.provider} copy hashes to the object's content_hash; only the recorded size (${item.size_bytes} bytes) was wrong, the bytes are ${f.size}` };
        }
    }
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
 * Apply one planned change. h = database handle. facts: { size, sha256 } of the good bytes (rebaseline,
 * regenerate). → the change with old values, or { skipped } when the row moved on.
 */
async function apply(h, step, facts = {}) {
    const cur = await h.prepare('SELECT id, size_bytes, content_hash, lifecycle_status FROM media_objects WHERE id = ?').get(step.object_id);
    if (!cur) return { ...step, skipped: 'object gone' };
    const obj = { ...cur, ...(step.read || {}) };
    const tx = async () => await h.tx(async () => {
        if (step.action === 'rebaseline' || step.action === 'regenerate' || step.action === 'resize') {
            const provider = step.action === 'regenerate' ? 'local' : step.provider;
            const loc = await h.prepare('SELECT id, state, size_bytes FROM media_locations WHERE object_id = ? AND provider = ?').get(obj.id, provider);
            if (!loc) return { ...step, skipped: `no ${provider} location` };
            if (step.action === 'resize' && facts.sha256 !== obj.content_hash) return { ...step, skipped: 'the copy does not hash to the object\'s content_hash' };
            const r = await h.prepare("UPDATE media_objects SET size_bytes = ?, content_hash = ?, updated_at = ov_now() WHERE id = ? AND size_bytes IS NOT DISTINCT FROM ? AND content_hash IS NOT DISTINCT FROM ?")
                .run(facts.size, facts.sha256, obj.id, obj.size_bytes, obj.content_hash);
            if (!r.changes) return { ...step, skipped: 'the object changed since it was read' };
            await h.prepare("UPDATE media_locations SET state = 'present', size_bytes = ?, verified_at = ov_now(), updated_at = ov_now() WHERE id = ?").run(facts.size, loc.id);
            const legacy = step.action === 'regenerate' ? null : await legacySize(h, step.legacy_ref, facts.size);
            return {
                ...step,
                old: { size_bytes: obj.size_bytes, content_hash: obj.content_hash, location_state: loc.state, location_size: loc.size_bytes, ...(legacy ? { legacy_file_size: legacy.old } : {}) },
                new: { size_bytes: facts.size, content_hash: facts.sha256, location_state: 'present', ...(legacy ? { legacy_file_size: facts.size } : {}) },
            };
        }
        if (step.action === 'failed_recording') {
            const r = await h.prepare("UPDATE media_objects SET lifecycle_status = 'failed', updated_at = ov_now() WHERE id = ? AND lifecycle_status = ?").run(obj.id, obj.lifecycle_status);
            if (!r.changes) return { ...step, skipped: 'the object changed since it was read' };
            return { ...step, old: { lifecycle_status: obj.lifecycle_status }, new: { lifecycle_status: 'failed' } };
        }
        return { ...step, skipped: 'nothing to write' };
    });
    return await tx();
}

/**
 * The legacy vods row behind a VOD object gets the object's size (file_size), so the projection from that
 * row (vodProjection) agrees with the object. Inside apply()'s transaction. → { old } or null (no row).
 */
async function legacySize(h, legacyRef, size) {
    const m = VOD_REF.exec(String(legacyRef || ''));
    if (!m) return null;
    const hasTable = await h.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'vods'").get();
    const row = hasTable && await h.prepare('SELECT file_size FROM vods WHERE id = ?').get(Number(m[1]));
    if (!row) return null;
    await h.prepare('UPDATE vods SET file_size = ? WHERE id = ?').run(size, Number(m[1]));
    return { old: row.file_size };
}

/** Undo one applied change where the row still holds what the repair wrote. → { restored } | { skipped } */
async function rollback(h, change) {
    if (!change || !change.old || !change.new) return { ...change, skipped: 'not an applied change' };
    const tx = async () => await h.tx(async () => {
        if (change.action === 'failed_recording') {
            const r = await h.prepare('UPDATE media_objects SET lifecycle_status = ? WHERE id = ? AND lifecycle_status = ?').run(change.old.lifecycle_status, change.object_id, change.new.lifecycle_status);
            return r.changes ? { ...change, restored: true } : { ...change, skipped: 'the row changed since' };
        }
        const r = await h.prepare('UPDATE media_objects SET size_bytes = ?, content_hash = ? WHERE id = ? AND size_bytes IS NOT DISTINCT FROM ? AND content_hash IS NOT DISTINCT FROM ?')
            .run(change.old.size_bytes, change.old.content_hash, change.object_id, change.new.size_bytes, change.new.content_hash);
        if (!r.changes) return { ...change, skipped: 'the row changed since' };
        const provider = change.action === 'regenerate' ? 'local' : change.provider;
        await h.prepare('UPDATE media_locations SET state = ?, size_bytes = ? WHERE object_id = ? AND provider = ?').run(change.old.location_state, change.old.location_size, change.object_id, provider);
        const m = VOD_REF.exec(String(change.legacy_ref || ''));
        if (m && 'legacy_file_size' in change.old) await h.prepare('UPDATE vods SET file_size = ? WHERE id = ? AND file_size IS NOT DISTINCT FROM ?').run(change.old.legacy_file_size, Number(m[1]), change.new.legacy_file_size);
        return { ...change, restored: true };
    });
    return await tx();
}

module.exports = { plan, apply, rollback, judgeProbe, MIN_SECONDS, SHOT_RE };
