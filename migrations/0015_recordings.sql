-- phase: expand
-- Recordings (docs/recordings.md): one playable video over a stream's parts. A stream recorded in several sessions
-- (a broadcaster who dropped and came back, a recorder restart) is several VODs; a recording joins them, so people see
-- one video that seeks across them. The recording is a native media object (kind 'asset', metadata.recording) whose
-- timeline is its parts' rows joined on every read (objects/timeline.js joinRows): no bytes are copied, and no VOD row
-- is added, so counts of videos and hours, tiering and health scans see each stored part exactly once.
-- Additive only: an older release never reads these tables, and lists every part as before.
CREATE TABLE media_recordings (
    object_id text COLLATE "C" PRIMARY KEY REFERENCES media_objects(id),
    app_id text COLLATE "C" NOT NULL,
    group_key text COLLATE "C" NOT NULL,          -- the app's own key for what makes one recording ("stream:2795" for Live)
    state text COLLATE "C" NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    UNIQUE (app_id, group_key)
);

CREATE TABLE media_recording_parts (
    recording_object_id text COLLATE "C" NOT NULL REFERENCES media_recordings(object_id) ON DELETE CASCADE,
    seq integer NOT NULL CHECK (seq >= 1),
    vod_id bigint NOT NULL,
    gap_before_ms bigint NOT NULL DEFAULT 0,      -- wall time between the previous part's end and this one's start (not played)
    stream_offset_ms bigint,                      -- where the part starts in the app's own clock (Live: stream time), when sent
    PRIMARY KEY (recording_object_id, seq),
    UNIQUE (vod_id)
);

-- A clip over a recording (POST /clips with recording_time): its window is in recording time and its clip_of edge goes
-- to the recording's object; vod_id stays the recording's first part, the video people know.
ALTER TABLE clips ADD COLUMN recording_object_id text COLLATE "C";
