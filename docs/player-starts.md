# Player starts — ask 288

Measured 2026-11-10 UTC with system Chrome and fresh Playwright contexts, browser cache cold. No Live stream was online (`/api/streams`: `{"streams":[],"agents":[]}`). Live `/vod/6298` redirects to Video `/watch?v=sU4LkcV7PpM`; these are two entry paths to the same 341-second ROBOT recording, not independent encodes. Its joined HLS object is `med_01M729VRTW6E3NPTTM008H0GAA`.

Phone: 1.6 Mbit/s down, 150 ms latency, 4x CPU slowdown, 390px. Computer: 10 Mbit/s down, 40 ms latency, native CPU, 1280px. Upload 0.75 Mbit/s. TTFF starts at the explicit muted play request (after the video element appears), and ends at requestVideoFrameCallback. Rebuffer ratio is waiting time divided by the following 20 seconds of wall time. Seek tests start from 220 seconds in a fresh context. One sample per entry/profile/position; these are diagnostic samples, not statistical estimates. The shared test host was busy (load 22–26 on 8 CPUs); reruns need the same caveat. Page loading and automatic preloading may precede the play request.

## Before

| Entry | Profile | Position | TTFF, s | Rebuffer | Observed tier |
|---|---|---:|---:|---:|---|
| live-recording | phone | 0s | 12.451 | 16.01% | B2 via Media |
| live-recording | phone | 220s | 15.126 | 4.14% | B2 via Media |
| live-recording | computer | 0s | 2.877 | 0.00% | B2 via Media |
| live-recording | computer | 220s | 3.848 | 0.00% | B2 via Media |
| video-recording | phone | 0s | 12.123 | 16.44% | B2 via Media |
| video-recording | phone | 220s | 14.914 | 5.97% | B2 via Media |
| video-recording | computer | 0s | 2.597 | 0.00% | B2 via Media |
| video-recording | computer | 220s | 3.923 | 0.00% | B2 via Media |

Both opening and later segments redirect to `s3.us-west-004.backblazeb2.com`; Media may proxy packed chunks. No R2 response was observed. The part-source master offers only 720p (BANDWIDTH 3403963, average 2383603): greater than the phone throughput, so buffer changes cannot make this source sustainable on that connection. A low rung must exist before it can be selected.

Evidence: `player-starts-evidence/measure.cjs`, `before.json`. The script saves hostnames only, never presigned URL queries. Production source URLs and the public page are used directly; no database writes or credentials.

## After

Pending Shared review and Media deployment. Do not treat a local Shared override as a production rollout.

## Next for the design

No layout or control changes. Cards adopting Shared warming need a public HLS source attribute; the main session owns their markup and appearance.
