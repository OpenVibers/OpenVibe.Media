-- phase: expand
-- VIS-6's last item: an unsafe-image review sorts an object into one of exactly three categories.
--   fine          allowed, including nudity
--   sex_acts      never public: the object is made private (kept for its owner)
--   minor_sexual  always blocked: quarantined even from a signed read, with the operator's report id
-- A visible upload is 'pending' until Vision answers, so an unreviewed image is never served publicly.
-- Rows uploaded before this migration have NULL and keep serving as they did.
ALTER TABLE media_objects ADD COLUMN review_category text COLLATE "C";
ALTER TABLE media_objects ADD COLUMN review_status text COLLATE "C";
ALTER TABLE media_objects ADD COLUMN review_report_id text COLLATE "C";
ALTER TABLE media_objects ADD COLUMN reviewed_at timestamptz;
ALTER TABLE media_objects ADD CONSTRAINT media_objects_review_category
    CHECK (review_category IS NULL OR review_category IN ('fine', 'sex_acts', 'minor_sexual'));
ALTER TABLE media_objects ADD CONSTRAINT media_objects_review_status
    CHECK (review_status IS NULL OR review_status IN ('pending', 'clear', 'hidden', 'quarantined'));
ALTER TABLE media_objects ADD CONSTRAINT media_objects_review_report
    CHECK (review_report_id IS NULL OR review_report_id ~ '^vor_[0-9A-HJKMNP-TV-Z]{26}$');
CREATE INDEX media_objects_review_pending ON media_objects (review_status, id) WHERE review_status = 'pending';
CREATE INDEX media_objects_review_category ON media_objects (review_category, id) WHERE review_category IS NOT NULL;
