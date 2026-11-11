# Player starts — ask 288

Measured 2026-11-10 and 2026-11-11 UTC with system Chrome and fresh Playwright contexts, browser cache cold. No Live stream was online (`/api/streams`: `{"streams":[],"agents":[]}`). Live `/vod/6298` redirects to Video `/watch?v=sU4LkcV7PpM`; these are two entry paths to the same 341-second ROBOT recording, not independent encodes. Its joined HLS object is `med_01M729VRTW6E3NPTTM008H0GAA`.

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

Media #405 deployed, then Media #407 fixed the read path and deployed. The recording's opening rows now report `X-OV-Media-Provider: r2` and its later rows `b2` (`source/p1-000001.m4s` at 0 s r2, `source/p2-000019.m4s` at 217.297 s b2). Browser samples at 0 s fetched 7/7 opening responses from R2; a seek to 220 s mixed the two inits and the preload (R2) with the later segments (B2).

| Entry | Profile | Position | TTFF before, s | TTFF after, s | Rebuffer before | Rebuffer after |
|---|---|---:|---:|---:|---:|---:|
| live-recording | phone | 0s | 12.451 | 11.295 | 16.01% | 15.88% |
| live-recording | phone | 220s | 15.126 | 14.295 | 4.14% | 6.16% |
| live-recording | computer | 0s | 2.877 | 2.248 | 0.00% | 0.00% |
| live-recording | computer | 220s | 3.848 | 3.357 | 0.00% | 0.00% |
| video-recording | phone | 0s | 12.123 | 11.140 | 16.44% | 16.05% |
| video-recording | phone | 220s | 14.914 | 14.491 | 5.97% | 6.22% |
| video-recording | computer | 0s | 2.597 | 3.025 | 0.00% | 0.00% |
| video-recording | computer | 220s | 3.923 | 3.422 | 0.00% | 0.00% |

After host load was 15–31 on 8 CPUs (before 22–26), so one sample each is a diagnostic, not a controlled comparison. Phone opening TTFF fell by 0.98–1.16 s (about 8–10%); computer opening moved both ways (one entry 0.35 s slower); a 220 s seek fell 0.43–0.50 s on both profiles. Phone rebuffer ratio at the opening barely moved (the single 720p rung has average bandwidth above the phone's 1.6 Mbit/s, so the constraint is bandwidth, not the tier), and the 220 s phone samples rose by 0.25–2.0 points within sample noise. R2 removes the redirect to a cheap store, not the bytes.

The first after run was invalid: it showed a 145 s duration and no playback. R2 responses carry no `Access-Control-Allow-Origin`, so the redirect for the unpacked init segment failed in CORS mode, native HLS errored, and the page fell back to the complete file (Chrome then played nothing). Media #407 streams unpacked R2 rows through Media like packed slices; the rerun above has the full 341 s duration and advances normally. Do not read the discarded `after-fallback-invalid.json` as a measurement.

## Next for the design

No layout or control changes. Cards adopting Shared warming need a public HLS source attribute; the main session owns their markup and appearance.
