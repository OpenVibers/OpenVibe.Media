/**
 * OpenVibe.Media — Stream Recorder (RTMP pull + RTP ingest)
 *
 * Adapted from the predecessor's ffmpeg recorder, keyed by vodId (tenant apps
 * own their stream state and point ingest at a VOD they created):
 *
 *   RTMP:  POST ingest/rtmp { rtmp_url }   → ffmpeg pulls the URL, lossless
 *          stream-copy into a fragmented MP4 (H.264/AAC passthrough — near-zero
 *          CPU, live-seekable, kill-tolerant, and IS its own lossless master).
 *   RTP:   POST ingest/rtp/start { video, audio } → allocates a UDP port pair
 *          from the pool (RTP_PORT_MIN..MAX on 127.0.0.1), writes an SDP and
 *          starts ffmpeg listening. Codec passthrough (no decode → no re-encode):
 *          H.264 → fragmented .mp4 (video copy, audio→AAC); VP8/VP9 → .webm
 *          (video + Opus copied). Anything exotic falls back to a libvpx
 *          re-encode (with an H.264 lossless master when applicable).
 *
 * Do NOT hardcode .webm — the served extension follows the copied container.
 *
 * A periodic remux writes a .seekable sidecar every 60s so DVR viewers can
 * seek into the growing recording (see media-tools.remuxForLiveSeeking).
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db/database');
const config = require('../config');
const tools = require('./media-tools');

// Grace period for ffmpeg to flush the trailer/cues after SIGINT before we
// force-kill. Generous on purpose — a long recording's trailer flush must not
// be cut short (that truncates the VOD). Cleared the instant ffmpeg exits.
const STOP_GRACE_MS = parseInt(process.env.VOD_STOP_GRACE_MS, 10) || 60000;

// Disk guardian thresholds (free bytes on the VOD volume).
const DISK_WARN_BYTES = (parseFloat(process.env.VOD_DISK_WARN_GB) || 15) * 1024 * 1024 * 1024;
const DISK_CRIT_BYTES = (parseFloat(process.env.VOD_DISK_CRIT_GB) || 5) * 1024 * 1024 * 1024;

function _isControlledFfmpegError(line, expectedShutdown) {
    if (!line || !expectedShutdown) return false;
    const normalized = line.toLowerCase();
    return /demux.*timeout|timeout|broken pipe|connection.*reset|closed|end of file|sigterm|sigint|error while reading/i.test(normalized);
}

function _isFfmpegCorruptionLine(line) {
    if (!line) return false;
    const normalized = line.toLowerCase();
    return /error while decoding|concealing|non[- ]monotonically increasing dts|missing picture in access unit|invalid .* header|invalid .* nal unit|could not find codec parameters|moov atom|invalid packet/i.test(normalized);
}

function _trackFfmpegDiagnostics(line, recording) {
    if (!recording || !_isFfmpegCorruptionLine(line)) return;
    recording.ffmpegCorruptionWarnings = (recording.ffmpegCorruptionWarnings || 0) + 1;
    if (recording.ffmpegCorruptionWarnings >= 5) {
        recording._ffmpegCorrupted = true;
    }
}

// ── RTP port pool (UDP 12000-12199 on 127.0.0.1 per CONTRACTS) ──

const _usedPorts = new Set();

/** Allocate an even base port with base+1 free (RTP + RTCP). */
function allocatePortPair() {
    let start = config.rtp.portMin;
    if (start % 2 !== 0) start += 1;
    for (let p = start; p + 1 <= config.rtp.portMax; p += 2) {
        if (!_usedPorts.has(p) && !_usedPorts.has(p + 1)) {
            _usedPorts.add(p);
            _usedPorts.add(p + 1);
            return p;
        }
    }
    return null;
}

function releasePortPair(basePort) {
    if (!basePort) return;
    _usedPorts.delete(basePort);
    _usedPorts.delete(basePort + 1);
}

// ── SDP for ffmpeg receiving RTP (PlainRtpTransport senders) ──

function _formatFmtpParameters(params) {
    return Object.entries(params || {}).map(([k, v]) => `${k}=${v}`).join(';');
}

/**
 * Build an SDP string for FFmpeg to receive RTP.
 * video/audio descriptors: { payloadType, codec, clockRate, channels?, parameters?, ssrc?, rtcpFeedback? }
 */
function buildRtpSdp(video, audio, videoPort, videoRtcpPort, audioPort, audioRtcpPort) {
    const lines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=OpenVibe.Media VOD Recording',
        'c=IN IP4 127.0.0.1',
        't=0 0',
    ];

    const vPT = video.payloadType;
    const vCodecName = String(video.codec || 'VP8').split('/').pop();
    const vFeedback = Array.isArray(video.rtcpFeedback) ? video.rtcpFeedback : [];
    const videoProtocol = vFeedback.length > 0 ? 'RTP/AVPF' : 'RTP/AVP';
    lines.push(`m=video ${videoPort} ${videoProtocol} ${vPT}`);
    lines.push(`a=rtpmap:${vPT} ${vCodecName}/${video.clockRate || 90000}`);
    if (videoRtcpPort) lines.push(`a=rtcp:${videoRtcpPort} IN IP4 127.0.0.1`);
    if (video.ssrc) lines.push(`a=ssrc:${video.ssrc} cname:record-video`);
    if (video.parameters) {
        const fmtp = _formatFmtpParameters(video.parameters);
        if (fmtp) lines.push(`a=fmtp:${vPT} ${fmtp}`);
    }
    for (const fb of vFeedback) {
        if (!fb || !fb.type) continue;
        lines.push(`a=rtcp-fb:${vPT} ${fb.type}${fb.parameter ? ` ${fb.parameter}` : ''}`);
    }
    lines.push('a=recvonly');

    if (audio && audioPort) {
        const aPT = audio.payloadType;
        const aCodecName = String(audio.codec || 'opus').split('/').pop();
        const channels = audio.channels || 2;
        const aFeedback = Array.isArray(audio.rtcpFeedback) ? audio.rtcpFeedback : [];
        const audioProtocol = aFeedback.length > 0 ? 'RTP/AVPF' : 'RTP/AVP';
        lines.push(`m=audio ${audioPort} ${audioProtocol} ${aPT}`);
        lines.push(`a=rtpmap:${aPT} ${aCodecName}/${audio.clockRate || 48000}/${channels}`);
        if (audioRtcpPort) lines.push(`a=rtcp:${audioRtcpPort} IN IP4 127.0.0.1`);
        if (audio.ssrc) lines.push(`a=ssrc:${audio.ssrc} cname:record-audio`);
        if (audio.parameters) {
            const fmtp = _formatFmtpParameters(audio.parameters);
            if (fmtp) lines.push(`a=fmtp:${aPT} ${fmtp}`);
        }
        for (const fb of aFeedback) {
            if (!fb || !fb.type) continue;
            lines.push(`a=rtcp-fb:${aPT} ${fb.type}${fb.parameter ? ` ${fb.parameter}` : ''}`);
        }
        lines.push('a=recvonly');
    }
    lines.push('');
    return lines.join('\r\n');
}

class StreamRecorder {
    constructor() {
        /** @type {Map<number, object>} vodId → recording state */
        this.activeRecordings = new Map();
        this._diskState = 'ok';   // 'ok' | 'warning' | 'critical'

        const vodDir = path.resolve(config.vod.path);
        if (!fs.existsSync(vodDir)) fs.mkdirSync(vodDir, { recursive: true });
    }

    isRecording(vodId) {
        return this.activeRecordings.has(Number(vodId));
    }

    activeCount() {
        return this.activeRecordings.size;
    }

    _cleanupFailedVod(vodId, filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            try {
                db.run('DELETE FROM vods WHERE id = ?', [vodId]);
                console.log(`[VOD] Deleted stale failed VOD ${vodId}`);
            } catch (err) {
                console.warn(`[VOD] Failed to delete stale VOD ${vodId}:`, err.message);
            }
            return;
        }
        try {
            db.run(
                'UPDATE vods SET is_recording = 0, health_status = ?, health_issues_json = ?, quarantined_at = datetime(\'now\'), is_public = 0 WHERE id = ?',
                ['corrupt', JSON.stringify(['failed_recording_start']), vodId]
            );
            console.log(`[VOD] Marked failed VOD ${vodId} as corrupt`);
        } catch (err) {
            console.warn(`[VOD] Failed to mark VOD ${vodId} as corrupt:`, err.message);
        }
    }

    _guardCanRecord(vod) {
        if (!vod) return { ok: false, error: 'VOD not found' };
        if (this.activeRecordings.has(vod.id)) return { ok: false, error: 'Already recording this VOD' };
        // Disk guardian: when the VOD volume is critically low, refuse to start
        // rather than risk filling the disk (which corrupts every active recording).
        if (this._diskState === 'critical') {
            return { ok: false, error: 'Disk critically low — recording refused' };
        }
        return { ok: true };
    }

    _registerCommon(vod, proc, filePath, masterPath, extra = {}) {
        const recording = {
            vodId: vod.id,
            appId: vod.app_id,
            process: proc,
            filePath,
            masterFilePath: masterPath || null,
            startTime: Date.now(),
            remuxTimer: null,
            _expectedShutdown: false,
            ffmpegCorruptionWarnings: 0,
            _ffmpegCorrupted: false,
            ...extra,
        };

        // Periodic live-seeking remux: .seekable sidecar every 60s so DVR viewers
        // can seek into the growing recording; first pass at 30s for early DVR.
        recording.remuxTimer = setInterval(() => this._periodicRemux(vod.id), 60000);
        setTimeout(() => {
            if (this.activeRecordings.has(vod.id)) this._periodicRemux(vod.id);
        }, 30000);

        this.activeRecordings.set(vod.id, recording);
        db.run('UPDATE vods SET is_recording = 1, file_path = ? WHERE id = ?', [filePath, vod.id]);
        if (masterPath) db.run('UPDATE vods SET master_file_path = ? WHERE id = ?', [masterPath, vod.id]);
        return recording;
    }

    _wireProcess(recording, label) {
        const { process: proc, vodId } = recording;

        proc.stderr?.on('data', (data) => {
            const line = data.toString();
            const rec = this.activeRecordings.get(vodId);
            _trackFfmpegDiagnostics(line, rec);
            if (line.includes('Error') || line.includes('error')) {
                if (_isControlledFfmpegError(line, rec?._expectedShutdown)) return;
                console.error(`[VOD] FFmpeg error (${label}, vod ${vodId}):`, line.trim());
            }
        });

        proc.on('exit', (code, signal) => {
            console.log(`[VOD] FFmpeg exited for vod ${vodId} (${label}, code: ${code}, signal: ${signal})`);
            const rec = this.activeRecordings.get(vodId);
            const finalizeOpts = {
                startTimeMs: rec?.startTime,
                ffmpegCorrupted: rec?._ffmpegCorrupted || false,
            };
            this._teardown(vodId);
            // Let finalizeVod handle remux, probe, thumbnail, webhook.
            // Short delay to ensure the file is fully flushed to disk.
            setTimeout(() => {
                require('./finalize').finalizeVod(vodId, finalizeOpts).catch(err => {
                    console.error(`[VOD] Finalization failed for vod ${vodId}:`, err.message);
                });
            }, 2000);
        });

        proc.on('error', (err) => {
            console.error(`[VOD] FFmpeg spawn error (${label}, vod ${vodId}):`, err.message);
            const rec = this.activeRecordings.get(vodId);
            const filePath = rec?.filePath;
            this._teardown(vodId);
            require('./finalize').finalizeVod(vodId, { startTimeMs: rec?.startTime }).catch(() => {
                db.run('UPDATE vods SET is_recording = 0 WHERE id = ?', [vodId]);
            });
            if (filePath && !fs.existsSync(filePath)) this._cleanupFailedVod(vodId, filePath);
        });
    }

    _teardown(vodId) {
        const rec = this.activeRecordings.get(vodId);
        if (!rec) return;
        if (rec._killTimer) { clearTimeout(rec._killTimer); rec._killTimer = null; }
        if (rec.remuxTimer) { clearInterval(rec.remuxTimer); rec.remuxTimer = null; }
        if (rec.sdpPath) { try { fs.unlinkSync(rec.sdpPath); } catch { /* */ } }
        if (rec.rtpVideoPort) releasePortPair(rec.rtpVideoPort);
        if (rec.rtpAudioPort) releasePortPair(rec.rtpAudioPort);
        this.activeRecordings.delete(vodId);
    }

    /**
     * Run periodic live-seeking remux and update DB duration/file size.
     */
    _periodicRemux(vodId) {
        const rec = this.activeRecordings.get(vodId);
        if (!rec || !rec.filePath || !fs.existsSync(rec.filePath)) return;

        const elapsed = Math.round((Date.now() - rec.startTime) / 1000);
        try {
            const stat = fs.statSync(rec.filePath);
            db.run('UPDATE vods SET duration_seconds = ?, file_size = ? WHERE id = ?',
                [elapsed, stat.size, rec.vodId]);
        } catch {}

        tools.remuxForLiveSeeking(rec.filePath).catch(() => {});
    }

    // ── RTMP ingest ──────────────────────────────────────────

    /**
     * Pull an RTMP URL into a fragmented MP4 via lossless stream-copy.
     * Exactly the predecessor's RTMP path — no re-encode, always real-time,
     * live-seekable, kill-tolerant, its own lossless master.
     */
    startRtmp(vod, rtmpUrl) {
        const guard = this._guardCanRecord(vod);
        if (!guard.ok) return guard;
        if (!/^rtmps?:\/\//i.test(String(rtmpUrl || ''))) {
            return { ok: false, error: 'rtmp_url must be an rtmp:// or rtmps:// URL' };
        }

        const filename = `vod-${vod.app_id}-${vod.id}-${Date.now()}.mp4`;
        const filePath = path.resolve(config.vod.path, filename);

        const ffmpegArgs = [
            '-y',
            '-rw_timeout', '15000000',
            '-i', rtmpUrl,
            // ── Lossless stream-copy → fragmented MP4 ──
            // No re-encode (H.264/AAC pass straight through from the RTMP feed), so
            // this ALWAYS keeps real-time regardless of source resolution/bitrate.
            // Fragmented (frag_keyframe/empty_moov/default_base_moof) so the growing
            // file is seekable live for DVR and survives an abrupt kill without a
            // moov-atom rewrite.
            '-c', 'copy',
            '-fflags', '+genpts',
            '-max_muxing_queue_size', '1024',
            '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            filePath,
        ];

        let proc;
        try {
            proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            return { ok: false, error: `ffmpeg spawn failed: ${err.message}` };
        }

        const recording = this._registerCommon(vod, proc, filePath, null, { protocol: 'rtmp' });
        this._wireProcess(recording, 'rtmp');

        console.log(`[VOD] Recording started: vod ${vod.id} → ${filename} (rtmp pull)`);
        return { ok: true, filePath };
    }

    // ── RTP ingest ───────────────────────────────────────────

    /**
     * Allocate ports, write SDP, start ffmpeg listening for RTP.
     * @param {object} vod       vods row
     * @param {object} video     { payloadType, codec, clockRate, ssrc?, parameters?, rtcpFeedback? }
     * @param {object} [audio]   same shape (codec e.g. 'opus')
     * @returns {ok, videoPort, audioPort} — caller points PlainRtpTransports at 127.0.0.1
     */
    startRtp(vod, video, audio) {
        const guard = this._guardCanRecord(vod);
        if (!guard.ok) return guard;
        if (!video || video.payloadType == null || !video.codec) {
            return { ok: false, error: 'video { payloadType, codec, clockRate } required' };
        }

        const videoPort = allocatePortPair();
        if (videoPort == null) return { ok: false, error: 'RTP port pool exhausted' };
        const videoRtcpPort = videoPort + 1;
        let audioPort = null;
        let audioRtcpPort = null;
        if (audio && audio.payloadType != null) {
            audioPort = allocatePortPair();
            if (audioPort == null) {
                releasePortPair(videoPort);
                return { ok: false, error: 'RTP port pool exhausted' };
            }
            audioRtcpPort = audioPort + 1;
        }

        const sdpContent = buildRtpSdp(video, audioPort ? audio : null, videoPort, videoRtcpPort, audioPort, audioRtcpPort);
        const sdpPath = path.join(os.tmpdir(), `openvibe-media-vod-${vod.id}-${Date.now()}.sdp`);
        try {
            fs.writeFileSync(sdpPath, sdpContent, 'utf8');
        } catch (err) {
            releasePortPair(videoPort);
            releasePortPair(audioPort);
            return { ok: false, error: `SDP write failed: ${err.message}` };
        }

        const ffmpegArgs = [
            '-y',
            '-use_wallclock_as_timestamps', '1',
            '-protocol_whitelist', 'file,rtp,udp',
            '-thread_queue_size', '2048',
            '-analyzeduration', '10000000',
            '-probesize', '5000000',
            '-avoid_negative_ts', 'make_zero',
            // Don't honor any rotation display-matrix the source may (mis)send
            // mid-stream — that flipped VODs 90° partway through.
            '-noautorotate',
            '-i', sdpPath,
            '-fflags', '+genpts+discardcorrupt+nobuffer+igndts',
            '-err_detect', 'ignore_err',
        ];

        // ── Codec-passthrough recording (no decode → no re-encode) ──────────
        // Copying the bitstream straight through (exactly like the proven RTMP
        // path) removes the decode entirely: zero re-encode CPU, no rotation/
        // shear/melt (there is no decode to desync), no separate .master.mkv
        // (the copied file IS lossless), kill-tolerant fragmented output.
        // Mapping: H.264 → fragmented .mp4 (video copy, audio → AAC for universal
        // browser support since Opus-in-MP4 is patchy); VP8/VP9 → .webm (video +
        // Opus copied, both native to WebM). Anything exotic falls back to the
        // legacy libvpx re-encode (+ lossless master when H.264/Opus).
        const vCodec = String(video.codec || '').toLowerCase();
        const isH264 = vCodec.includes('h264');
        const isVpx = vCodec.includes('vp8') || vCodec.includes('vp9');
        const passthrough = isH264 || isVpx;

        const ext = isH264 ? '.mp4' : '.webm';
        const filename = `vod-${vod.app_id}-${vod.id}-${Date.now()}${ext}`;
        const filePath = path.resolve(config.vod.path, filename);
        let masterPath = null;

        const normalizeVod = process.env.VOD_NO_NORMALIZE !== '1';
        const VOD_SCALE_VF = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1';

        if (passthrough) {
            ffmpegArgs.push('-map', '0:v:0', '-c:v', 'copy');
            if (audioPort) {
                ffmpegArgs.push('-map', '0:a?');
                if (isH264) {
                    ffmpegArgs.push('-c:a', 'aac', '-b:a', '160k');   // Opus → AAC (cheap, audio-only)
                } else {
                    ffmpegArgs.push('-c:a', 'copy');                  // Opus is native to WebM
                }
            } else {
                ffmpegArgs.push('-an');
            }
            if (isH264) {
                // Fragmented MP4: seekable while still growing (live DVR) and it
                // survives an abrupt kill without a moov rewrite — same rationale
                // as the RTMP path, which is why neither needs a lossless master.
                ffmpegArgs.push('-max_muxing_queue_size', '1024',
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', filePath);
            } else {
                ffmpegArgs.push('-f', 'webm', filePath);
            }
        } else {
            // ── Legacy fallback: decode + re-encode to VP8/WebM, with a lossless
            //    stream-copy .master.mkv alongside (recovery fallback) unless the
            //    disk is under pressure. H.264/VP8/VP9 never reach this branch —
            //    they passthrough above — so this only handles exotic codecs.
            masterPath = this._diskState === 'ok' ? filePath.replace(/\.webm$/, '.master.mkv') : null;
            const libvpxVideo = [
                ...(normalizeVod ? ['-vf', VOD_SCALE_VF] : []),
                '-c:v', 'libvpx',
                '-b:v', '2000k',
                '-crf', '18',
                '-deadline', 'realtime',
                '-cpu-used', '4',
                // Keyframe every 2s → seekable WebM
                '-force_key_frames', 'expr:gte(t,n_forced*2)',
                '-g', '240',
            ];
            if (masterPath) {
                ffmpegArgs.push('-map', '0', '-c:v', 'copy', '-c:a', 'copy', '-f', 'matroska', masterPath, '-map', '0', ...libvpxVideo);
            } else {
                ffmpegArgs.push(...libvpxVideo);
            }
            if (audioPort) {
                ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k', '-application', 'audio');
            } else {
                ffmpegArgs.push('-an');
            }
            ffmpegArgs.push('-f', 'webm', filePath);
        }

        let proc;
        try {
            proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            try { fs.unlinkSync(sdpPath); } catch { /* */ }
            releasePortPair(videoPort);
            releasePortPair(audioPort);
            return { ok: false, error: `ffmpeg spawn failed: ${err.message}` };
        }

        const recording = this._registerCommon(vod, proc, filePath, masterPath, {
            protocol: 'rtp',
            sdpPath,
            rtpVideoPort: videoPort,
            rtpAudioPort: audioPort,
        });
        this._wireProcess(recording, 'rtp');

        const recMode = passthrough ? `passthrough ${isH264 ? 'H.264→mp4' : 'VP8/9→webm'} copy` : 'libvpx re-encode';
        console.log(`[VOD] RTP recording started: vod ${vod.id} → ${filename} [${recMode}] (video:${videoPort}${audioPort ? ` audio:${audioPort}` : ''})`);
        return { ok: true, videoPort, audioPort, filePath };
    }

    /**
     * Gracefully stop recording a VOD.
     * FFmpeg SIGINT triggers trailer write → exit handler → finalizeVod.
     */
    stopRecording(vodId) {
        vodId = Number(vodId);
        const recording = this.activeRecordings.get(vodId);
        if (!recording) return false;

        console.log(`[VOD] Stopping recording for vod ${vodId}`);
        recording._expectedShutdown = true;

        if (recording.remuxTimer) {
            clearInterval(recording.remuxTimer);
            recording.remuxTimer = null;
        }

        if (!recording.process) {
            this._teardown(vodId);
            this._cleanupFailedVod(vodId, recording.filePath);
            return true;
        }

        try {
            // SIGINT lets FFmpeg write cues/trailer for seekability
            recording.process.kill('SIGINT');
        } catch {
            try { recording.process.kill('SIGTERM'); } catch { /* ignore */ }
        }

        // Safety net: force-kill only if FFmpeg is REALLY stuck. Force-killing too
        // early truncates the file and produces short/unseekable VODs.
        recording._killTimer = setTimeout(() => {
            try {
                if (recording.process && !recording.process.killed) {
                    console.warn(`[VOD] FFmpeg didn't exit within grace for vod ${vodId} — force-killing (VOD may be truncated)`);
                    recording.process.kill('SIGKILL');
                }
            } catch { /* ignore */ }
        }, STOP_GRACE_MS);
        return true;
    }

    /**
     * Disk guardian: sample free space on the VOD volume. Under 'critical' no
     * new recordings start (existing ones keep running). Called on an interval.
     */
    checkDisk() {
        let free = 0;
        try { free = require('./vod-storage').diskUsage(config.vod.path).available || 0; } catch { return; }
        if (!free) return;
        const prev = this._diskState;
        const state = free < DISK_CRIT_BYTES ? 'critical' : free < DISK_WARN_BYTES ? 'warning' : 'ok';
        this._diskState = state;
        if (state !== prev) {
            const gb = (free / 1024 / 1024 / 1024).toFixed(1);
            if (state === 'ok') console.log(`[VOD] Disk recovered — ${gb}GB free (recordings back to normal)`);
            else console.warn(`[VOD] Disk ${state.toUpperCase()} — only ${gb}GB free on the VOD volume`);
        }
        if (state === 'ok') return;

        // Under pressure: nudge the storage sweep to offload cold VODs.
        try { const vs = require('./vod-storage'); if (typeof vs.runSweep === 'function') vs.runSweep().catch(() => {}); } catch { /* */ }
    }

    /** Stop all active recordings (for graceful shutdown). */
    stopAll() {
        for (const [vodId] of this.activeRecordings) {
            this.stopRecording(vodId);
        }
    }
}

module.exports = new StreamRecorder();
module.exports.buildRtpSdp = buildRtpSdp;
