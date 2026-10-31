'use strict';
// An audio-only browser broadcast records (2026-10-31). Stream 2827 (moosely, 2026-10-30) sent a microphone and no camera,
// and RTP ingest refused it ("video required"), so the stream had no VOD at all while the Rundown, which listens to the
// audio, had it. The SDP now leaves out the video section when there is no video, and startRtp takes audio alone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-rec-audio-'));
process.env.VOD_STORAGE_PATH = process.env.VOD_STORAGE_PATH || root;
const recorder = require('../server/vod/recorder');

const audio = { payloadType: 100, codec: 'opus', clockRate: 48000, channels: 2 };
const video = { payloadType: 101, codec: 'VP8', clockRate: 90000 };

// The SDP: audio only has one m= line, for audio.
const sdpAudio = recorder.buildRtpSdp(null, audio, null, null, 12002, 12003);
assert.ok(!/m=video/.test(sdpAudio), 'no video section without video');
assert.match(sdpAudio, /^m=audio 12002 RTP\/AVP 100$/m, 'the audio section');
assert.match(sdpAudio, /^a=rtpmap:100 opus\/48000\/2$/m);
assert.match(sdpAudio, /^a=rtcp:12003 IN IP4 127\.0\.0\.1$/m);

// With video the SDP is as it was.
const sdpBoth = recorder.buildRtpSdp(video, audio, 12000, 12001, 12002, 12003);
assert.match(sdpBoth, /^m=video 12000 RTP\/AVP 101$/m);
assert.match(sdpBoth, /^m=audio 12002 RTP\/AVP 100$/m);
assert.ok(sdpBoth.indexOf('m=video') < sdpBoth.indexOf('m=audio'), 'video first, as before');

(async () => {
    // Neither track: refused, and the message names both options.
    const none = await recorder.startRtp({ id: 999001, app_id: 'live' }, null, null);
    assert.strictEqual(none.ok, false);
    assert.match(String(none.error), /video .* or audio/, `the refusal says what is needed: ${none.error}`);
    // The source carries the audio-only path: one audio map into WebM, Opus copied, no video map.
    const src = fs.readFileSync(path.join(__dirname, '../server/vod/recorder.js'), 'utf8');
    assert.match(src, /if \(audioOnly\) \{[\s\S]{0,400}'-map', '0:a:0'[\s\S]{0,200}'-c:a', 'copy'/, 'Opus is copied into WebM');
    assert.match(src, /const videoPort = hasVideo \? allocatePortPair\(\) : null;/, 'no video port is taken for audio alone');
    console.log('recorder: an audio-only broadcast records (SDP without video, startRtp takes audio alone) ok');
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
