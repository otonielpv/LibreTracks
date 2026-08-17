ALTER TABLE telemetry_events
  ADD COLUMN installation_age_bucket TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE telemetry_events
  ADD COLUMN active_days_bucket TEXT NOT NULL DEFAULT 'unknown';

CREATE TABLE IF NOT EXISTS telemetry_product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  utc_day TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'project_created', 'project_opened', 'audio_imported',
    'audio_import_failed', 'playback_started', 'project_saved',
    'session_exported', 'session_export_failed', 'project_open_failed',
    'feature_compact_view', 'feature_metronome', 'feature_voice_guide',
    'feature_ambient_pads', 'feature_automation', 'feature_warp',
    'feature_midi', 'feature_remote_panel', 'active_5m', 'active_15m',
    'active_30m', 'active_60m'
  )),
  daily_device_token TEXT NOT NULL CHECK (length(daily_device_token) = 64),
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  device_class TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'XX' CHECK (length(country_code) = 2)
);

CREATE INDEX IF NOT EXISTS telemetry_product_received_at
  ON telemetry_product_events(received_at);

CREATE INDEX IF NOT EXISTS telemetry_product_event
  ON telemetry_product_events(event_name, received_at);

CREATE INDEX IF NOT EXISTS telemetry_product_daily_token
  ON telemetry_product_events(daily_device_token, received_at);
