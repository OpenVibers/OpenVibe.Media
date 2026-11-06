-- phase: expand
-- VIS-6 review follow-up: a category-3 result places an evidence hold in the same transaction as the
-- quarantine, so neither the owner's delete nor retention purge can destroy the object. The hold is
-- released only by an operator's overruling category (fine or sex_acts), with who and when on the hold row.
ALTER TABLE media_objects ADD COLUMN review_hold_id bigint;
-- One row per operator view of a hidden/quarantined object: who, when, and when the 60-second URL expires.
CREATE TABLE media_review_views (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id     text COLLATE "C" NOT NULL,
    app_id        text COLLATE "C" NOT NULL,
    viewer_sub    text COLLATE "C" NOT NULL,
    expires_at    text COLLATE "C",
    created_at    text COLLATE "C" DEFAULT ov_now()
);
CREATE INDEX media_review_views_object ON media_review_views (object_id, created_at DESC);
