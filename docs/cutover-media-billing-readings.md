# Cutover runbook — Media storage and delivery readings to OpenVibe.Billing (plan T5 step 14)

This change makes Media the last producer of `platform.usage-sample@1` readings for its own storage and
delivery: `migrations/0004_billing_readings.sql` adds the SDK usage reporter's outbox plus Media's aggregation
state, and `server/billing.js` aggregates each closed UTC hour/day into one reading per (project, subject) and
relays it to OpenVibe.Billing's `POST /api/v1/usage`. Nothing is renamed, dropped, altered or backfilled, and
the reads and writes that serve media are untouched. No money moves here: Billing stores the readings and rates
them in its own sweep (its `BILLING_RATING_INTERVAL_MS`, off by default, and no rate card loaded = no charge).

## What the migration does

`migrations/0004_billing_readings.sql` (`phase: expand`) creates two tables and a trigger:

- `billing_readings` — the `openvibe-sdk/usage` `createUsageReporter` outbox: `event_id` (the reading's
  idempotency key, unique), `envelope` (the reading JSON), and the relay's columns (`attempts`,
  `next_attempt_at`, `sent_at`, `seq`, `rejected_at`, `last_error`). The reporter only ever moves the delivery
  columns; the trigger `billing_readings_frozen` refuses every change to `event_id`/`envelope`/`created_at`, so a
  stored reading is immutable and a retry always posts the same body. A generated `idempotency_key` column names
  `event_id` for readers.
- `billing_periods` — one row per `(metric, period_start)` already aggregated (`gib-delivered`: the UTC hour;
  `gb-month`: the UTC day), so a re-run inserts nothing.

The runner is `openvibe-sdk/db`'s `migrate()`, started by `server/db/database.js` as the owner
(`DATABASE_DIRECT_URL`) when the process boots: it locks `ov_migrations`, runs the file in one transaction,
records id `0004` with its checksum, and refuses a later edit of it.

## What is recorded

| metric (`resource`) | source | period | unit | provider |
|---|---|---|---|---|
| `gib-delivered` | the closed hour's object reads (placement demand rollups, `server/placement/demand.js`) × the object's `size_bytes` | closed UTC hour | `GiB` | `local` |
| `gb-month` | `media_locations` present copies, summed by provider | closed UTC day | `GB` | the tier (`local`/`b2`/`r2`) |

One reading per (project, subject), plus the tier for `gb-month`. Only `apps.env = 'production'` tenants with a
`project_id` are recorded (first-party and sandbox are dropped before `record()`); an object without an
`owner_subject` is stored with its project alone and Billing leaves it unrated until it names a user subject.
Because delivery reads live in the demand rollups, turn this on where `VALKEY_URL` is set in production: with no
Valkey only the process's own counters are seen, and a period with no reads records nothing (it still marks the
period so a later run does not re-scan).

## Order

1. **Backup.** Take the logical dump of the `media` database before the deploy (the rule for any data change,
   even additive): `sudo ovhost backup --all --logical`. Note the stamp it prints; the way back uses it.
2. **Merge and deploy** through the pipeline (`ovhost deploy media`; `--wait-idle` is not needed: no recording
   state changes shape). The first process to boot applies `0004`.
3. **Leave `MEDIA_BILLING_INTERVAL_MS` unset (0) at first.** Nothing is aggregated, no reading is queued and
   nothing is posted.
4. **Network grant** (OpenVibe.Network, its own change): the `media` client needs `billing.usage.record` on
   audience `openvibe.billing`. Network's `server/identity/principals.js` already grants it; confirm it is
   deployed before step 5. Without it every token request for that audience is refused, each post is logged as
   `[usage] media reading not delivered (will retry)`, and the readings wait in the table (no media read is
   affected).
5. **Turn it on**: add `MEDIA_BILLING_INTERVAL_MS` (for example `300000`, every 5 minutes) and `OV_BILLING_URL`
   (Billing's internal URL) to `/etc/openvibe/media.env`, and `OV_BILLING_AUDIENCE` only if it differs from
   `openvibe.billing`; then restart through `ovhost deploy media --restart`.

## Verification

- `ov access run openvibe-ovh health media` (or `/api/ready`) answers 200 after the deploy.
- The migration is recorded: `SELECT id, name, phase FROM ov_migrations WHERE id = '0004'` returns
  `0004 | billing_readings | expand`, and with the interval still 0 `SELECT COUNT(*) FROM billing_readings` is 0.
- After step 5: `SELECT metric, COUNT(*) AS n, MAX(period_start) AS last FROM billing_periods GROUP BY metric`
  shows the newest closed hour and day appearing; `SELECT COUNT(*) FROM billing_readings WHERE sent_at IS NULL
  AND rejected_at IS NULL` stays small. `GET /api/v1/usage?service=media` in Billing (its `billing.ledger.admin`
  capability) lists the readings with `idempotency_key` `media:deliver:<project>:<subject>:<hour>` and
  `media:store:<project>:<subject>:<tier>:<day>`.
- A reading is never edited: `UPDATE billing_readings SET envelope = '{}'::jsonb WHERE …` fails with
  `billing_readings: reading … is never edited`.
- A relay that cannot reach Billing leaves rows pending; a reading Billing refuses (any other 4xx) is marked
  `rejected_at` with `last_error` and never retried.

## Rollback

- **Code only** (the usual way back): `ovhost rollback media` (or `deploy/scripts/deploy.sh --rollback`). The
  previous release does not know the tables and ignores them; the applied migration is accepted (an applied id
  the release does not have is not an error). Pending readings stay and are posted when the release comes back
  (Billing dedupes on the reading's idempotency key).
- **Stop posting without a rollback:** remove `MEDIA_BILLING_INTERVAL_MS` (or set it to 0) and restart. Readings
  already queued stay in `billing_readings` and wait.
- **Remove the tables** (only if they must go; a contract step, by hand as the owner, after a code rollback):
  `DROP TABLE billing_readings; DROP TABLE billing_periods; DELETE FROM ov_migrations WHERE id = '0004';`.
- **Restore:** the dump from step 1 restores the database as it was before the deploy (OpenVibe.Host
  `docs/backups.md`); not needed for this additive change unless the database itself is damaged.
