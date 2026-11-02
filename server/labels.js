'use strict';
/**
 * Content labels (L1, labels and choices, 2026-10-31; Contracts 0.257.0 common.content-labels@1).
 *
 * The one label list and the shape a VOD or clip stores and returns: `{ labels, suggested }`. A creator sets a
 * label; the AI may suggest one, and a suggestion never applies itself. A label is not a ban: Media never hides a
 * row because of it, and the viewer's Network prefs decide what they see.
 */
const LABELS = Object.freeze(['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']);

const isLabel = (x) => typeof x === 'string' && LABELS.includes(x);

/** A clean label list from a creator's request, or null when it is not a list of known labels. */
function parseLabels(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const label of value) {
        if (!isLabel(label)) return null;
        if (!out.includes(label)) out.push(label);
    }
    return out;
}

/** The contract's shape from a jsonb column, a JSON string, or nothing: always two arrays of known labels. */
function labelsOf(row) {
    let raw = row && typeof row === 'object' && 'content_labels' in row ? row.content_labels : row;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    const pick = (v) => [...new Set((Array.isArray(v) ? v : []).filter(isLabel))];
    return { labels: pick(raw && raw.labels), suggested: pick(raw && raw.suggested) };
}

/** The shape to store. */
const shape = (labels, suggested = []) => ({ labels: [...new Set((labels || []).filter(isLabel))], suggested: [...new Set((suggested || []).filter(isLabel))] });

/** Apply a creator's labels and drop the ones they just confirmed from the suggestions. */
function confirmed(current, labels) {
    const now = labelsOf(current);
    return { labels: [...labels], suggested: now.suggested.filter((l) => !labels.includes(l)) };
}

module.exports = { LABELS, isLabel, parseLabels, labelsOf, shape, confirmed };
