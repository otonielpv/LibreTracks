-- Store ratings, downloads and reviews for the public site (functions/api/store/).
-- Ratings and text reviews are different things: every row in store_play_ratings
-- is one rating, and only the rows with `text` are reviews.

-- One cached JSON blob per source, refreshed by functions/api/store/stats.ts.
CREATE TABLE store_cache (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- First downloads per store. `period` is 'YYYY-MM' for a whole month or
-- 'YYYY-MM-DD' for one day of a month that has no monthly row yet.
CREATE TABLE store_downloads (
  store TEXT NOT NULL CHECK (store IN ('appstore', 'play')),
  period TEXT NOT NULL,
  downloads INTEGER NOT NULL,
  PRIMARY KEY (store, period)
);

-- Every Google Play rating, with or without text. The Play API only returns the
-- last 7 days of reviews, so they are accumulated here; the monthly review CSVs
-- from the Play bucket also bring the ratings without text.
CREATE TABLE store_play_ratings (
  review_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  submitted_day TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  author TEXT,
  language TEXT,
  version TEXT,
  text TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);

-- Seed: the October and November 2026 review CSVs downloaded by hand from Play
-- Console, plus the three reviews of 2026-11-23 read from the Play API.
INSERT OR IGNORE INTO store_play_ratings
  (review_id, rating, submitted_day, updated_at, author, language, version, text) VALUES
  ('85feee1b-c77f-4335-9f82-3259e372c19a', 5, '2026-10-15', 1792032471642, NULL, 'es', NULL, 'Súper está bien optimizada, es fácil de usar y me encantó la interfaz'),
  ('15386d97-4edd-4168-9f64-b01416a70417', 5, '2026-10-22', 1792640291523, NULL, 'es', '1.14.0', 'la mejor Opción y herramienta en multitracl'),
  ('5ba4bd98-d805-4e70-ad25-3854e1782cdb', 5, '2026-10-23', 1792790126210, NULL, 'es', '1.14.0', 'Que buena aplicación de verdad'),
  ('ecadbfe4-1e11-4a80-aee3-ca21d4f838d5', 5, '2026-11-06', 1793941434975, NULL, 'es', '1.15.0', 'La mejor app para reproducir secuencias 👌🏻'),
  ('a16a0621-e11e-4aa6-83e8-29fe012dbacd', 5, '2026-11-10', 1794279192452, NULL, 'es', '1.16.0', 'exelente aplicación, sin publicidad ni restricciones. Realmente útil para los que tenemos conocimientos en dirección musical y herramientas de audio.'),
  ('csv-1794771757660', 5, '2026-11-15', 1794771757660, NULL, 'es', '1.17.1', NULL),
  ('5766b0f5-655a-4578-a84f-e77c8c6163df', 5, '2026-11-23', 1795435200000, 'Sergio Castellanos', 'es', '1.17.1', 'Increíble app, llena de funciones utiles, con una curva de aprendizaje muy interesante, sencilla pero a la vez compleja depende de todo lo que quieras lograr, la sigo utilizando como mi daw principal para multitracks'),
  ('38a0e3b4-4051-4950-9d74-5bf99df26288', 5, '2026-11-23', 1795435200000, 'Jonathan Hernández', 'es', '1.17.1', 'exelente muy buena 👌'),
  ('dd3a3eb9-5882-4375-a854-39247c82e92c', 5, '2026-11-23', 1795435200000, 'Elvis Garcia', 'es', NULL, 'exelente aplicación me a parecido perfecta');

-- Seed: App Store first downloads (Product Type 1F) of the closed months, read
-- from the Sales Reports API on 2026-11-25.
INSERT OR IGNORE INTO store_downloads (store, period, downloads) VALUES
  ('appstore', '2026-09', 259),
  ('appstore', '2026-10', 485);

-- Seed: Google Play "Daily User Installs" from the monthly install CSVs
-- downloaded by hand (2026-11 runs to the 18th; the bucket sync replaces it).
INSERT OR IGNORE INTO store_downloads (store, period, downloads) VALUES
  ('play', '2026-08', 6),
  ('play', '2026-09', 13),
  ('play', '2026-10', 614),
  ('play', '2026-11', 329);
