-- Local weekday of the app start, "0" (Sunday) to "6" (Saturday).
-- utc_day cannot answer the question on its own: a Sunday evening service in
-- the Americas is already Monday in UTC, so deriving the weekday server-side
-- would move exactly the worship services we want to count into Monday.
-- Clients older than this column keep reporting 'unknown'.
ALTER TABLE telemetry_events
  ADD COLUMN local_weekday TEXT NOT NULL DEFAULT 'unknown'
  CHECK (local_weekday IN ('0', '1', '2', '3', '4', '5', '6', 'unknown'));

CREATE INDEX IF NOT EXISTS telemetry_events_local_weekday
  ON telemetry_events(received_at, local_weekday);
