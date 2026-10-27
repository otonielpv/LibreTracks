-- Apply before deploying the website and releasing clients with these events.
-- Rebuild the table to extend its closed event taxonomy without losing history.
ALTER TABLE telemetry_product_events
  RENAME TO telemetry_product_events_before_feature_adoption;

CREATE TABLE telemetry_product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  utc_day TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'project_created', 'project_opened', 'audio_imported',
    'audio_import_failed', 'playback_started', 'project_saved',
    'session_exported', 'session_export_failed', 'project_open_failed',
    'feature_daw_view', 'feature_compact_view', 'feature_live_view',
    'feature_metronome', 'feature_voice_guide', 'feature_ambient_pads',
    'feature_automation', 'feature_warp', 'feature_midi',
    'feature_remote_panel', 'feature_setlist_view', 'feature_video',
    'feature_lyrics_chords', 'feature_cloud', 'feature_network_host',
    'feature_network_guest', 'feature_audio_render', 'feature_song_analysis',
    'feature_level_songs', 'feature_midi_learn', 'feature_vamp',
    'active_5m', 'active_15m', 'active_30m', 'active_60m'
  )),
  daily_device_token TEXT NOT NULL CHECK (length(daily_device_token) = 64),
  app_version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  device_class TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'XX' CHECK (length(country_code) = 2)
);

INSERT INTO telemetry_product_events (
  id, received_at, utc_day, event_name, daily_device_token,
  app_version, os, arch, device_class, country_code
)
SELECT
  id, received_at, utc_day, event_name, daily_device_token,
  app_version, os, arch, device_class, country_code
FROM telemetry_product_events_before_feature_adoption;

DROP TABLE telemetry_product_events_before_feature_adoption;

CREATE INDEX telemetry_product_received_at
  ON telemetry_product_events(received_at);

CREATE INDEX telemetry_product_event
  ON telemetry_product_events(event_name, received_at);

CREATE INDEX telemetry_product_daily_token
  ON telemetry_product_events(daily_device_token, received_at);
