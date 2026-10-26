-- phase: expand
-- A video whose picture changes shape mid-stream (a phone turned, a resolution lowered) is cut in periods, one init
-- segment each (server/jobs/shapes.js): the first period's is init.mp4 at seq 0, period n >= 2's is init-<n>.mp4 at seq
-- -(100 + n), named by its media rows' init_name (0005). This widens 0005's seq CHECK to admit those names. Additive
-- only: an older release reads the rows with init_name already (its playlists put a discontinuity before each init) and
-- never writes one.
ALTER TABLE media_timeline DROP CONSTRAINT IF EXISTS media_timeline_seq_check;
ALTER TABLE media_timeline ADD CONSTRAINT media_timeline_seq_check
    CHECK (seq >= 0 OR name IN ('init-head.mp4', 'init-tail.mp4') OR name ~ '^init-[0-9]{1,4}\.mp4$');
