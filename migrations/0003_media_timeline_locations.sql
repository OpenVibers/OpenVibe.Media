-- phase: expand
-- Reference counts for shared segment locations (docs/media-fabric.md §3/§4; the foundation of materialized clips). A
-- row names a location by the durable pair (durable_provider, key) and/or its local copy (local_path); a location's
-- bytes are shared whenever several objects' rows name it (a source and the clips over it). "How many objects name this
-- location?" (timeline.namedElsewhere) is answered by a query over media_timeline — there is no counter table, so a count
-- can never drift from the rows — and these two indexes make those reference queries index lookups.
-- Additive only: an older release never reads it (it just keeps deleting its own locations, as before). Never edited
-- after it runs; a further change is a new migration.
CREATE INDEX IF NOT EXISTS media_timeline_location_durable ON media_timeline (durable_provider, key);
CREATE INDEX IF NOT EXISTS media_timeline_location_local ON media_timeline (local_path);
