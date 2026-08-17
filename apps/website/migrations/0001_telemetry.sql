CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  utc_day TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name = 'app_started'),
  daily_device_token TEXT NOT NULL CHECK (length(daily_device_token) = 64),
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  device_class TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telemetry_events_received_at
  ON telemetry_events(received_at);

CREATE INDEX IF NOT EXISTS telemetry_events_daily_token
  ON telemetry_events(daily_device_token, received_at);

CREATE INDEX IF NOT EXISTS telemetry_events_breakdown
  ON telemetry_events(received_at, app_version, os, arch, device_class);
