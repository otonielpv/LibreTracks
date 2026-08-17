ALTER TABLE telemetry_events
  ADD COLUMN country_code TEXT NOT NULL DEFAULT 'XX'
  CHECK (length(country_code) = 2);

CREATE INDEX IF NOT EXISTS telemetry_events_country
  ON telemetry_events(received_at, country_code);
