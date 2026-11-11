'use strict';
/**
 * The origins the attachment routes answer: every first-party origin the service manifests declare (the same list
 * Network's server/first-party-origins.js builds), plus the hard-coded ones that must survive a registry failure,
 * plus the local development ports outside production. Only exact https origins: a tenant subdomain is never one.
 */
const contracts = require('openvibe-contracts');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BASE = [
    'https://openvibe.network',
    'https://openvibe.live', 'https://www.openvibe.live',
    'https://openvibe.tools',
    'https://openvibe.games', 'https://www.openvibe.games', 'https://play.openvibe.games',
    'https://openvibe.media',
    'https://openvibe.community',
    'https://openvibe.space',
];
const DEV = [
    'http://localhost:3000', 'http://localhost:4000', 'http://127.0.0.1:4000',
    'http://localhost:4001', 'http://localhost:4100', 'http://localhost:4200',
    'http://localhost:4400', 'http://localhost:4940', 'http://localhost:8000',
    'http://localhost:5173',
];

let cached = null;

function openVibeOrigins() {
    if (cached) return cached;
    const out = new Set(BASE);
    for (const m of (contracts.services && contracts.services.manifests) || []) {
        for (const d of m.domains || []) {
            const host = String(d || '').trim().toLowerCase();
            if (HOST_RE.test(host)) out.add(`https://${host}`);
        }
    }
    if (process.env.NODE_ENV !== 'production') for (const o of DEV) out.add(o);
    cached = out;
    return out;
}

module.exports = { openVibeOrigins };
