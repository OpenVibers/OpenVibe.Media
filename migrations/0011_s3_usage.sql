-- phase: expand
-- Per-zone usage on the S3 surface (ADR-031 section 8, server/s3/usage.js): the counts of one zone's series in one UTC
-- hour, added to every 30 s from memory. A closed hour is sent as media.usage.recorded (common.usage-recorded@1) and
-- marked with the revision it was sent at; counts that land after it raise the revision, and the hour is sent again.
-- Counts only: no key, object key, address or subject is kept.
CREATE TABLE media_s3_usage (
    zone_id         text COLLATE "C" NOT NULL,
    project_id      text COLLATE "C" NOT NULL,
    env             text COLLATE "C" NOT NULL,
    window_start    bigint NOT NULL,                             -- ms since the epoch, on the hour (UTC)
    capability      text COLLATE "C" NOT NULL,                   -- media.object.upload | read | list | delete
    unit            text COLLATE "C" NOT NULL,                   -- requests | egress_bytes | byte_hours
    quantity        bigint NOT NULL DEFAULT 0,
    errors          bigint NOT NULL DEFAULT 0,
    error_codes     text NOT NULL DEFAULT '{}',                  -- { "media.s3.<code>": n }, the 20 largest
    samples         text NOT NULL DEFAULT '[]',                  -- the last 10 failures: { at, code, status }
    revision        integer NOT NULL DEFAULT 1,
    sent_revision   integer,                                     -- the revision last sent; NULL: not sent yet
    updated_at      bigint NOT NULL,
    PRIMARY KEY (zone_id, window_start, capability, unit)
);
CREATE INDEX media_s3_usage_unsent ON media_s3_usage (window_start) WHERE sent_revision IS NULL OR sent_revision < revision;
