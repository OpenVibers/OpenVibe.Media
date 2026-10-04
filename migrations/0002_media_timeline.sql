-- phase: expand
-- Segment-native video, first slice (docs/media-fabric.md §3, F3.1): the timeline index. One row per CMAF segment of one
-- rendition of a media object; segment 0 is the rendition's init segment (init.mp4, start = end = 0). Times are integer
-- milliseconds on the object's own timeline: [start_ms, end_ms) is contiguous from one segment to the next and
-- keyframe_ms is the segment's first keyframe. The bytes are the segment's own key under the object's prefix
-- (<object>/<rendition>/<name>) on this node's disk (local_path) and, once durable, on durable_provider; packed_object_id
-- with byte_offset/byte_length names the ~60 s chunk object a packed segment lives in (F3.3; NULL until then).
-- durability: 'local' = only on this node's disk, 'durable' = the durable provider confirmed the bytes.
-- Additive only: an older release never reads it. Never edited after it runs; a further change is a new migration.
CREATE TABLE media_timeline (
    object_id text COLLATE "C" NOT NULL,
    rendition text COLLATE "C" NOT NULL,
    seq bigint NOT NULL CHECK (seq >= 0),
    name text COLLATE "C" NOT NULL,
    start_ms bigint NOT NULL,
    end_ms bigint NOT NULL,
    keyframe_ms bigint,
    key text COLLATE "C" NOT NULL,
    local_path text COLLATE "C",
    durable_provider text COLLATE "C" CHECK (durable_provider IN ('b2', 'r2')),
    packed_object_id text COLLATE "C",
    byte_offset bigint,
    byte_length bigint NOT NULL,
    sha256 text COLLATE "C" NOT NULL,
    durability text COLLATE "C" NOT NULL DEFAULT 'local' CHECK (durability IN ('local', 'durable')),
    job_id text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now(),
    updated_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (object_id, rendition, seq),
    CHECK (end_ms >= start_ms)
);
-- "segments of a rendition in order" is the primary key; "the segment at time t" walks this one backwards from t.
CREATE INDEX media_timeline_at ON media_timeline (object_id, rendition, start_ms);
CREATE INDEX media_timeline_packed ON media_timeline (packed_object_id) WHERE packed_object_id IS NOT NULL;
