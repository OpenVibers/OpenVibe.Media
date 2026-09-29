'use strict';
// Placement metrics (F1, part 6): histogram, counters, breaker gauge — wired into the registry.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-plmetrics-'));
    Object.assign(process.env, {
        VOD_PATH: path.join(tmp, 'vods'), CLIPS_PATH: path.join(tmp, 'clips'), PASTES_PATH: path.join(tmp, 'pastes'),
        THUMBNAILS_PATH: path.join(tmp, 'thumbnails'), FILES_PATH: path.join(tmp, 'files'), OBJECTS_PATH: path.join(tmp, 'objects'),
        ASSETS_PATH: path.join(tmp, 'assets'), MEDIA_PUBLIC_URL: 'https://media.test', OV_NETWORK_URL: 'http://127.0.0.1:9',
        RELEASE_COMMIT: 'abcdef1234567',
    });
    fs.mkdirSync(process.env.VOD_PATH, { recursive: true });
    fs.mkdirSync(process.env.CLIPS_PATH, { recursive: true });
    fs.mkdirSync(process.env.PASTES_PATH, { recursive: true });
    fs.mkdirSync(process.env.THUMBNAILS_PATH, { recursive: true });
    fs.mkdirSync(process.env.FILES_PATH, { recursive: true });
    fs.mkdirSync(process.env.OBJECTS_PATH, { recursive: true });
    fs.mkdirSync(process.env.ASSETS_PATH, { recursive: true });
    for (const k of ['MEDIA_B2_ENDPOINT', 'MEDIA_B2_BUCKET', 'MEDIA_R2_ENDPOINT', 'MEDIA_R2_BUCKET', 'EVENTS_URL']) process.env[k] = '';

    const metrics = require('openvibe-shared/metrics');
    const registry = metrics.createRegistry();
    const observability = require('../server/observability');
    observability.domainMetrics(registry, { db: require('../server/db/database'), recorder: { activeCount: () => 0 }, events: { status: async () => ({ enabled: false }) } });

    // Inc a few metrics through the binding and check they show up.
    const binding = require('../server/placement/metrics-binding');
    binding.inc('media_router_decisions_total', { provider: 'r2', purpose: 'playback', reason: 'fastest-healthy' });
    binding.inc('media_router_decisions_total', { provider: 'b2', purpose: 'playback', reason: 'fastest-healthy' });
    binding.inc('media_presign_cache_total', { result: 'hit' });
    binding.inc('media_presign_cache_total', { result: 'miss' });
    binding.inc('media_storage_alerts_total', { kind: 'drain_stalled' });
    binding.observeLatency('r2', 'presign', 120);
    binding.observeError('b2', 'presign');

    const text = await registry.metricsAsync();
    assert.ok(text.includes('media_router_decisions_total{provider="r2"'), 'router decision rendered');
    assert.ok(text.includes('media_router_decisions_total{provider="b2"'), 'router decision (b2) rendered');
    assert.ok(text.includes('media_presign_cache_total{result="hit"}'), 'presign cache hit rendered');
    assert.ok(text.includes('media_presign_cache_total{result="miss"}'), 'presign cache miss rendered');
    assert.ok(text.includes('media_storage_alerts_total{kind="drain_stalled"}'), 'storage alert rendered');
    assert.ok(text.includes('media_provider_latency_seconds_bucket'), 'latency histogram rendered');
    assert.ok(text.includes('media_provider_errors_total'), 'errors counter rendered');
    assert.ok(text.includes('media_provider_breaker_open'), 'breaker gauge rendered');

    console.log('placement-metrics: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });