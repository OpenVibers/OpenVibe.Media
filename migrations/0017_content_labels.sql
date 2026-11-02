-- phase: expand
-- Content labels (L1, labels and choices, 2026-10-31; Contracts 0.257.0 common.content-labels@1).
--
-- A creator labels a VOD or a clip; MediaHub writes it through PUT /api/v1/:app/vods/:id and /clips/:id, and every
-- read (the watch page, Live's cards, the app's own manager) carries the shape. The AI may suggest a label and it is
-- stored in `suggested`; a suggestion changes nothing until the creator confirms it. A viewer's Network label prefs
-- decide what to do with a label; the label itself never hides anything.
--
-- Expand only: an older release never reads these columns, and the defaults keep every existing row label-free.
ALTER TABLE vods ADD COLUMN IF NOT EXISTS content_labels jsonb NOT NULL DEFAULT '{"labels": [], "suggested": []}'::jsonb;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS content_labels jsonb NOT NULL DEFAULT '{"labels": [], "suggested": []}'::jsonb;
CREATE INDEX IF NOT EXISTS vods_content_labels ON vods USING gin (content_labels);
CREATE INDEX IF NOT EXISTS clips_content_labels ON clips USING gin (content_labels);
