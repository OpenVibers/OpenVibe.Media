-- phase: expand
-- One view store for every content kind (the owner, 11-12: "add view count, and count views even if you're just
-- watching on the feed … then engaged viewers when you actually watch more of the video"). `service` + `kind` +
-- `item_id` name the item in its owner's space (media/vod, media/clip, live/stream, network/feed…), so Media can
-- count a Feed item and a Live stream without owning their rows. `creator_subject` and `site` are the optional
-- Report dimensions the caller sends (a canonical subject or channel username, and a site id).
--
-- Privacy: content_view_actors stores a keyed hash of the person's canonical subject or anonymous session id,
-- never an IP address and never a user agent. No other table here stores an identifier.
--
-- content_view_counts is the item total (a reviewable number the API reads); content_view_days is the same
-- numbers by UTC day for Report; content_view_actors is the 30-minute window, cumulative watch time and the one
-- engagement per viewer.

CREATE TABLE content_view_counts (
    service text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    site text COLLATE "C",
    creator_subject text COLLATE "C",
    views bigint NOT NULL DEFAULT 0,
    engaged bigint NOT NULL DEFAULT 0,
    previews bigint NOT NULL DEFAULT 0,
    live_peak bigint,
    updated_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (service, kind, item_id)
);

CREATE TABLE content_view_days (
    service text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    day text COLLATE "C" NOT NULL,
    site text COLLATE "C",
    creator_subject text COLLATE "C",
    views bigint NOT NULL DEFAULT 0,
    engaged bigint NOT NULL DEFAULT 0,
    previews bigint NOT NULL DEFAULT 0,
    live_peak bigint,
    PRIMARY KEY (service, kind, item_id, day)
);

CREATE TABLE content_view_actors (
    service text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    actor text COLLATE "C" NOT NULL,
    first_ms bigint NOT NULL,
    last_view_ms bigint,
    last_seen_ms bigint,
    watched_seconds double precision NOT NULL DEFAULT 0,
    engaged_ms bigint,
    live boolean NOT NULL DEFAULT false,
    PRIMARY KEY (service, kind, item_id, actor)
);

CREATE INDEX idx_content_view_days_day ON content_view_days(day);
CREATE INDEX idx_content_view_days_creator ON content_view_days(creator_subject, day);
CREATE INDEX idx_content_view_days_site ON content_view_days(site, day);
CREATE INDEX idx_content_view_actors_seen ON content_view_actors(service, kind, item_id, last_seen_ms);

-- The counts every page already had keep working: a VOD's and a clip's current view_count becomes its starting
-- view total (the legacy visit counter keeps deduping for six hours and now adds to the same total).
INSERT INTO content_view_counts (service, kind, item_id, views)
SELECT 'media', 'vod', id::text, COALESCE(view_count, 0) FROM vods
ON CONFLICT (service, kind, item_id) DO NOTHING;
INSERT INTO content_view_counts (service, kind, item_id, views)
SELECT 'media', 'clip', id::text, COALESCE(view_count, 0) FROM clips
ON CONFLICT (service, kind, item_id) DO NOTHING;
