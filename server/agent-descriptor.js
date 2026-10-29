'use strict';
// What openvibe.media tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public media index and the watch pages Media is the
// canonical home of, the Media API under /api/v1, llms.txt, llms-full.txt and the sitemap. No OpenAPI document or
// MCP endpoint is published here, so none is named.
module.exports = {
    id: 'media',
    name: 'OpenVibe.Media',
    purpose: 'The network\'s media service: VOD and clip storage and public playback, thumbnails, generic files, and the canonical object model, placement and lifecycle for every OpenVibe app.',
    home: 'https://openvibe.media',
    site: 'openvibe.media',
    api: '/api/v1',
    policy: {
        auth: ['none', 'bearer', 'Network OIDC'],
        rateLimit: 'The public pages and playable bytes are not limited per address; the API answers a tenant token (or a signed-in person) and is bounded by the project\'s quotas, published at /limits.json',
    },
};
