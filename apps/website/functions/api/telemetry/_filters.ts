/// <reference types="@cloudflare/workers-types" />

/**
 * Cross-filtering for the private product dashboard.
 *
 * Every chart on the dashboard is also a control: clicking a country, an hour,
 * a version or a feature bar narrows every other chart to that slice. This file
 * turns the resulting selection into SQL.
 *
 * Three shapes of filter exist, because the two telemetry tables do not carry
 * the same columns:
 *
 * - `column` — the dimension exists on both tables (country, version, OS,
 *   device class). Filtered in place.
 * - `hour` — derived from `received_at` on whichever table is being read, so an
 *   hour selection means exactly what a one-hour absolute range would mean,
 *   repeated across every day of the range.
 * - `cohort` — the dimension lives on one table only (weekday, installation
 *   age and cumulative active days live on `telemetry_events`; event names live
 *   on `telemetry_product_events`). Filtering the other table means selecting
 *   the device-days that match over there. `(utc_day, daily_device_token)` is
 *   the device-day key the whole dashboard already counts by, so the cohort
 *   join is the same grain as every metric it filters.
 *
 * The file name starts with an underscore and it exports no `onRequest*`
 * handler, so Pages does not turn it into a route.
 */

export const FILTER_KEYS = [
  "country",
  "version",
  "os",
  "device",
  "hour",
  "weekday",
  "installAge",
  "activeDays",
  "event",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Record<FilterKey, string[]>;
export type Clause = { sql: string; params: unknown[] };
export type Window = { from: number; to: number };

const ALLOWED_OS = new Set(["windows", "macos", "linux", "android", "ios", "unknown"]);
const ALLOWED_DEVICE_CLASS = new Set(["desktop", "mobile", "tablet", "unknown"]);
const ALLOWED_INSTALL_AGE = new Set([
  "day_0",
  "days_1_7",
  "days_8_30",
  "days_31_90",
  "days_91_plus",
  "unknown",
]);
const ALLOWED_ACTIVE_DAYS = new Set(["1", "2_3", "4_7", "8_30", "31_plus", "unknown"]);
const ALLOWED_WEEKDAY = new Set(["0", "1", "2", "3", "4", "5", "6"]);
// Mirrors PRODUCT_EVENTS in events.ts. Kept as its own copy rather than
// imported so that an event retired from ingestion can still be filtered on
// while it remains in the 90-day retention window.
const ALLOWED_EVENT = new Set([
  "project_created",
  "project_opened",
  "audio_imported",
  "audio_import_failed",
  "playback_started",
  "project_saved",
  "session_exported",
  "session_export_failed",
  "project_open_failed",
  "feature_daw_view",
  "feature_compact_view",
  "feature_live_view",
  "feature_metronome",
  "feature_voice_guide",
  "feature_ambient_pads",
  "feature_automation",
  "feature_warp",
  "feature_midi",
  "feature_remote_panel",
  "active_5m",
  "active_15m",
  "active_30m",
  "active_60m",
]);

// A selection is made by clicking; nobody picks 40 countries by hand. The cap
// exists so a hand-written URL cannot turn one request into an unbounded `IN`
// list, not to constrain real use.
const MAX_VALUES_PER_DIMENSION = 40;

type Definition =
  | { kind: "column"; column: string }
  | { kind: "hour" }
  | { kind: "cohort"; table: "telemetry_events" | "telemetry_product_events"; column: string };

const DEFINITIONS: Record<FilterKey, Definition> = {
  country: { kind: "column", column: "country_code" },
  version: { kind: "column", column: "app_version" },
  os: { kind: "column", column: "os" },
  device: { kind: "column", column: "device_class" },
  hour: { kind: "hour" },
  weekday: { kind: "cohort", table: "telemetry_events", column: "local_weekday" },
  installAge: { kind: "cohort", table: "telemetry_events", column: "installation_age_bucket" },
  activeDays: { kind: "cohort", table: "telemetry_events", column: "active_days_bucket" },
  event: { kind: "cohort", table: "telemetry_product_events", column: "event_name" },
};

const VALIDATORS: Record<FilterKey, (value: string) => boolean> = {
  country: (value) => /^[A-Z]{2}$/.test(value),
  version: (value) => /^[0-9A-Za-z.+_-]{1,32}$/.test(value),
  os: (value) => ALLOWED_OS.has(value),
  device: (value) => ALLOWED_DEVICE_CLASS.has(value),
  hour: (value) => /^(?:[01]\d|2[0-3])$/.test(value),
  weekday: (value) => ALLOWED_WEEKDAY.has(value),
  installAge: (value) => ALLOWED_INSTALL_AGE.has(value),
  activeDays: (value) => ALLOWED_ACTIVE_DAYS.has(value),
  event: (value) => ALLOWED_EVENT.has(value),
};

export function emptyFilters(): Filters {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, [] as string[]])) as Filters;
}

/**
 * Reads `f.country=ES,PT` style parameters. Values that do not belong to their
 * dimension are dropped rather than rejected, and the response echoes back what
 * survived, so a stale bookmark loses the dead filter instead of the dashboard.
 */
export function parseFilters(params: URLSearchParams): Filters {
  const filters = emptyFilters();
  for (const key of FILTER_KEYS) {
    const raw = params.get(`f.${key}`);
    if (!raw) continue;
    const accepted = new Set<string>();
    for (const candidate of raw.split(",")) {
      const value = candidate.trim();
      if (!value || !VALIDATORS[key](value)) continue;
      accepted.add(value);
      if (accepted.size >= MAX_VALUES_PER_DIMENSION) break;
    }
    filters[key] = [...accepted];
  }
  return filters;
}

export function hasAnyFilter(filters: Filters): boolean {
  return FILTER_KEYS.some((key) => filters[key].length > 0);
}

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/**
 * Builds the `AND ...` tail for one table.
 *
 * `exclude` leaves one dimension out. Every ranking on the dashboard doubles as
 * the picker for its own dimension, so it is filtered by the other dimensions
 * but never by itself: pick Spain and the country ranking still lists every
 * country, with Spain marked, so the next country is one click away instead of
 * requiring the filter to be cleared first.
 */
export function filterClause(
  target: "starts" | "product",
  alias: string,
  filters: Filters,
  window: Window,
  exclude?: FilterKey,
): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];
  let subquery = 0;

  for (const key of FILTER_KEYS) {
    if (key === exclude) continue;
    const values = filters[key];
    if (values.length === 0) continue;
    const definition = DEFINITIONS[key];

    if (definition.kind === "hour") {
      parts.push(
        `CAST(strftime('%H', ${alias}.received_at / 1000, 'unixepoch') AS INTEGER) IN (${placeholders(values)})`,
      );
      params.push(...values.map(Number));
      continue;
    }

    if (definition.kind === "column") {
      parts.push(`${alias}.${definition.column} IN (${placeholders(values)})`);
      params.push(...values);
      continue;
    }

    const native =
      (target === "starts" && definition.table === "telemetry_events") ||
      (target === "product" && definition.table === "telemetry_product_events");
    // An event cohort is never applied natively: `event_name IN (...)` on the
    // product table would keep only the matching rows, and the question the
    // dashboard is asking is what those device-days did in total, not how many
    // times they triggered the event that selected them.
    if (native && key !== "event") {
      parts.push(`${alias}.${definition.column} IN (${placeholders(values)})`);
      params.push(...values);
      continue;
    }

    subquery += 1;
    const cohort = `${alias}c${subquery}`;
    parts.push(
      `EXISTS (SELECT 1 FROM ${definition.table} ${cohort}
                WHERE ${cohort}.daily_device_token = ${alias}.daily_device_token
                  AND ${cohort}.utc_day = ${alias}.utc_day
                  AND ${cohort}.received_at >= ? AND ${cohort}.received_at < ?
                  AND ${cohort}.${definition.column} IN (${placeholders(values)}))`,
    );
    params.push(window.from, window.to, ...values);
  }

  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}
