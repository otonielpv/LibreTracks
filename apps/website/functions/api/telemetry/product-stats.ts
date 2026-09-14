/// <reference types="@cloudflare/workers-types" />

import {
  type AnalyticsEnv,
  authFailure,
  authenticate,
  noteTokenUse,
  serialiseToken,
} from "./_auth";
import {
  type FilterKey,
  type Filters,
  type Window,
  FILTER_KEYS,
  filterClause,
  parseFilters,
} from "./_filters";

type EventRow = { event: string; events: number; devices: number };
type SignalRow = { signal: string; devices: number };
type BucketRow = { label: string; devices: number };
type BreakdownRow = { label: string; sessions: number; devices: number };
type HourlyRow = { hour: string; sessions: number; devices: number };
type WeekdayRow = { weekday: string; sessions: number; devices: number };
type DailyRow = {
  day: string;
  activeDevices: number;
  activatedDevices: number;
  featureDevices: number;
};

const FEATURE_EVENTS = [
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
] as const;

const ACTIVATION_EVENTS = [
  "project_created",
  "project_opened",
  "audio_imported",
  "playback_started",
  "project_saved",
  "session_exported",
] as const;

const DAY_MS = 86_400_000;
// Every telemetry insert prunes both tables past this age (see events.ts), so
// no query can reach further back however wide a range the dashboard asks for.
const RETENTION_DAYS = 90;
const PRESET_DAYS = new Set([1, 7, 30, 90]);
// The dashboard builds "last 90 days" against its own clock, so by the time the
// request lands the retention floor has already moved past it by the round trip.
// Only a trim wider than that counts as the range having been cut short.
const CLAMP_TOLERANCE_MS = 60_000;

type Range = Window & { clamped: boolean };

function all<T>(db: D1Database, sql: string, params: unknown[]) {
  const statement = db.prepare(sql);
  return (params.length ? statement.bind(...params) : statement).all<T>();
}

function first<T>(db: D1Database, sql: string, params: unknown[]) {
  const statement = db.prepare(sql);
  return (params.length ? statement.bind(...params) : statement).first<T>();
}

const inList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/**
 * A ranking over one column of the app-start table.
 *
 * `exclude` is always the dimension being ranked: the ranking doubles as the
 * picker for its own filter, so narrowing to Spain must not reduce the country
 * list to Spain — otherwise the only way to look at the next country is to
 * clear the filter first.
 */
function breakdown(
  db: D1Database,
  column: "app_version" | "os" | "device_class" | "country_code",
  exclude: FilterKey,
  filters: Filters,
  range: Range,
  // Countries are shown as a scrollable ranking next to the map, so the whole
  // ISO 3166-1 range has to fit; the other dimensions stay capped at a top 20.
  limit = 20,
): Promise<D1Result<BreakdownRow>> {
  const clause = filterClause("starts", "e", filters, range, exclude);
  return all<BreakdownRow>(
    db,
    `SELECT e.${column} AS label, COUNT(*) AS sessions,
            COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
       FROM telemetry_events e
      WHERE e.received_at >= ? AND e.received_at < ?${clause.sql}
      GROUP BY e.${column}
      ORDER BY devices DESC, sessions DESC
      LIMIT ?`,
    [range.from, range.to, ...clause.params, limit],
  );
}

function bucketRanking(
  db: D1Database,
  column: "installation_age_bucket" | "active_days_bucket",
  exclude: FilterKey,
  filters: Filters,
  range: Range,
): Promise<D1Result<BucketRow>> {
  const clause = filterClause("starts", "e", filters, range, exclude);
  return all<BucketRow>(
    db,
    `SELECT e.${column} AS label,
            COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
       FROM telemetry_events e
      WHERE e.received_at >= ? AND e.received_at < ?
        AND e.${column} != 'unknown'${clause.sql}
      GROUP BY e.${column}`,
    [range.from, range.to, ...clause.params],
  );
}

function rate(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 10_000) / 100 : 0;
}

// Accepts both epoch milliseconds (what the dashboard sends) and anything
// Date.parse understands, so a range stays typeable by hand in the URL.
function parseInstant(value: string | null): number | null {
  if (!value) return null;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRange(params: URLSearchParams, now: number): Range {
  const floor = now - RETENTION_DAYS * DAY_MS;
  const requestedFrom = parseInstant(params.get("from"));
  const requestedTo = parseInstant(params.get("to"));
  if (requestedFrom !== null && requestedTo !== null && requestedFrom < requestedTo) {
    const from = Math.max(requestedFrom, floor);
    const to = Math.min(requestedTo, now);
    // A range entirely outside retention collapses; falling through to the
    // default window beats answering with an empty dashboard and no reason.
    if (from < to) {
      const trimmed =
        from - requestedFrom > CLAMP_TOLERANCE_MS ||
        requestedTo - to > CLAMP_TOLERANCE_MS;
      return { from, to, clamped: trimmed };
    }
  }
  const requestedDays = Number(params.get("days") ?? "30");
  const days = PRESET_DAYS.has(requestedDays) ? requestedDays : 30;
  // The one-day preset means the running UTC day rather than the last 24
  // hours: devices are counted per utc_day, so a rolling window straddling
  // midnight would count the same device twice. The wider presets stay rolling.
  const from = days === 1 ? Math.floor(now / DAY_MS) * DAY_MS : now - days * DAY_MS;
  return { from, to: now, clamped: false };
}

export const onRequestGet: PagesFunction<AnalyticsEnv> = async (context) => {
  const { env, request } = context;
  const auth = await authenticate(request, env);
  if (auth.role === "none") return authFailure(auth.reason);
  if (auth.role === "guest") {
    // Bookkeeping the reader must not wait on; see noteTokenUse.
    context.waitUntil(noteTokenUse(env, auth.token));
  }

  const generatedAt = Date.now();
  const params = new URL(request.url).searchParams;
  const range = resolveRange(params, generatedAt);
  const filters = parseFilters(params);
  const { from, to } = range;
  const span = to - from;
  // The comparison window is the same span immediately before, snapped up to
  // whole days: a partial day (Today, Last 6 hours) then lands on the same
  // clock hours yesterday instead of on the hours right before it.
  const shift = Math.ceil(span / DAY_MS) * DAY_MS;
  const previous: Range = { from: from - shift, to: to - shift, clamped: false };
  // Retention would only feed a truncated previous window, and an invented
  // drop is worse than no comparison at all.
  const comparable = previous.from >= generatedAt - RETENTION_DAYS * DAY_MS;

  const db = env.TELEMETRY_DB;
  const starts = filterClause("starts", "e", filters, range);
  const product = filterClause("product", "p", filters, range);
  const startsPrevious = filterClause("starts", "e", filters, previous);
  // Only worth a second round trip when an event cohort is actually selected;
  // with none active the self-excluded ranking is the unfiltered one.
  const eventFilterActive = filters.event.length > 0;
  const productPicker = filterClause("product", "p", filters, range, "event");

  const [
    totals,
    previousTotals,
    pickerTotals,
    eventsResult,
    pickerEventsResult,
    signalsResult,
    ageResult,
    activeDaysResult,
    dailyResult,
    hourlyResult,
    weekdayResult,
    countries,
    versions,
    operatingSystems,
    deviceClasses,
  ] = await Promise.all([
    first<{ appStarts: number; devices: number }>(
      db,
      `SELECT COUNT(*) AS appStarts,
              COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
         FROM telemetry_events e
        WHERE e.received_at >= ? AND e.received_at < ?${starts.sql}`,
      [from, to, ...starts.params],
    ),
    comparable
      ? first<{ appStarts: number; devices: number }>(
          db,
          `SELECT COUNT(*) AS appStarts,
                  COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
             FROM telemetry_events e
            WHERE e.received_at >= ? AND e.received_at < ?${startsPrevious.sql}`,
          [previous.from, previous.to, ...startsPrevious.params],
        )
      : Promise.resolve(null),
    eventFilterActive
      ? (() => {
          const clause = filterClause("starts", "e", filters, range, "event");
          return first<{ devices: number }>(
            db,
            `SELECT COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
               FROM telemetry_events e
              WHERE e.received_at >= ? AND e.received_at < ?${clause.sql}`,
            [from, to, ...clause.params],
          );
        })()
      : Promise.resolve(null),
    all<EventRow>(
      db,
      `SELECT p.event_name AS event, COUNT(*) AS events,
              COUNT(DISTINCT p.utc_day || ':' || p.daily_device_token) AS devices
         FROM telemetry_product_events p
        WHERE p.received_at >= ? AND p.received_at < ?${product.sql}
        GROUP BY p.event_name`,
      [from, to, ...product.params],
    ),
    eventFilterActive
      ? all<EventRow>(
          db,
          `SELECT p.event_name AS event, COUNT(*) AS events,
                  COUNT(DISTINCT p.utc_day || ':' || p.daily_device_token) AS devices
             FROM telemetry_product_events p
            WHERE p.received_at >= ? AND p.received_at < ?${productPicker.sql}
            GROUP BY p.event_name`,
          [from, to, ...productPicker.params],
        )
      : Promise.resolve(null),
    all<SignalRow>(
      db,
      `WITH signals AS (
         SELECT e.utc_day AS utc_day, e.daily_device_token AS daily_device_token,
                'app_started' AS signal
           FROM telemetry_events e
          WHERE e.received_at >= ? AND e.received_at < ?${starts.sql}
         UNION ALL
         SELECT p.utc_day, p.daily_device_token,
           CASE
             WHEN p.event_name IN ('project_created', 'project_opened') THEN 'project_ready'
             WHEN p.event_name = 'audio_imported' THEN 'audio_imported'
             WHEN p.event_name = 'playback_started' THEN 'playback_started'
             WHEN p.event_name IN ('project_saved', 'session_exported') THEN 'work_completed'
           END AS signal
           FROM telemetry_product_events p
          WHERE p.received_at >= ? AND p.received_at < ?
            AND p.event_name IN (${inList(ACTIVATION_EVENTS)})${product.sql}
       )
       SELECT signal, COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
         FROM signals WHERE signal IS NOT NULL GROUP BY signal`,
      [from, to, ...starts.params, from, to, ...product.params],
    ),
    bucketRanking(db, "installation_age_bucket", "installAge", filters, range),
    bucketRanking(db, "active_days_bucket", "activeDays", filters, range),
    all<DailyRow>(
      db,
      `WITH starts AS (
         SELECT e.utc_day AS day, COUNT(DISTINCT e.daily_device_token) AS activeDevices
           FROM telemetry_events e
          WHERE e.received_at >= ? AND e.received_at < ?${starts.sql}
          GROUP BY e.utc_day
       ), product AS (
         SELECT p.utc_day AS day,
           COUNT(DISTINCT CASE WHEN p.event_name IN (${inList(ACTIVATION_EVENTS)})
             THEN p.daily_device_token END) AS activatedDevices,
           COUNT(DISTINCT CASE WHEN p.event_name LIKE 'feature_%'
             THEN p.daily_device_token END) AS featureDevices
           FROM telemetry_product_events p
          WHERE p.received_at >= ? AND p.received_at < ?${product.sql}
          GROUP BY p.utc_day
       )
       SELECT starts.day, starts.activeDevices,
              COALESCE(product.activatedDevices, 0) AS activatedDevices,
              COALESCE(product.featureDevices, 0) AS featureDevices
         FROM starts LEFT JOIN product ON product.day = starts.day
        ORDER BY starts.day`,
      [from, to, ...starts.params, from, to, ...product.params],
    ),
    (() => {
      const clause = filterClause("starts", "e", filters, range, "hour");
      return all<HourlyRow>(
        db,
        `SELECT strftime('%H', e.received_at / 1000, 'unixepoch') AS hour,
                COUNT(*) AS sessions,
                COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
           FROM telemetry_events e
          WHERE e.received_at >= ? AND e.received_at < ?${clause.sql}
          GROUP BY hour ORDER BY hour`,
        [from, to, ...clause.params],
      );
    })(),
    // Grouped on the device-reported local weekday, never on utc_day: a
    // Sunday evening service in the Americas is already Monday in UTC.
    (() => {
      const clause = filterClause("starts", "e", filters, range, "weekday");
      return all<WeekdayRow>(
        db,
        `SELECT e.local_weekday AS weekday, COUNT(*) AS sessions,
                COUNT(DISTINCT e.utc_day || ':' || e.daily_device_token) AS devices
           FROM telemetry_events e
          WHERE e.received_at >= ? AND e.received_at < ?
            AND e.local_weekday != 'unknown'${clause.sql}
          GROUP BY e.local_weekday ORDER BY weekday`,
        [from, to, ...clause.params],
      );
    })(),
    breakdown(db, "country_code", "country", filters, range, 300),
    breakdown(db, "app_version", "version", filters, range),
    breakdown(db, "os", "os", filters, range),
    breakdown(db, "device_class", "device", filters, range),
  ]);

  const activeDeviceDays = totals?.devices ?? 0;
  // Index 0 is Sunday, matching Date.getDay() on the client.
  const weekdayRows = Array.from({ length: 7 }, (_, weekday) => {
    const row = weekdayResult.results.find(
      (candidate) => Number(candidate.weekday) === weekday,
    );
    return {
      weekday,
      sessions: row?.sessions ?? 0,
      devices: row?.devices ?? 0,
    };
  });
  const byEvent = new Map(eventsResult.results.map((row) => [row.event, row]));
  // The feature and session-depth rankings are the picker for the event
  // dimension, so they read the self-excluded counts; every other number on the
  // page reads the fully filtered ones.
  const byPickerEvent = pickerEventsResult
    ? new Map(pickerEventsResult.results.map((row) => [row.event, row]))
    : byEvent;
  // Their percentages need the matching denominator: the device-days that pass
  // every filter except the event cohort. Reusing activeDeviceDays would divide
  // a cohort-free numerator by a cohort-restricted total and print adoption
  // rates above 100%.
  const pickerDeviceDays = pickerTotals?.devices ?? activeDeviceDays;
  const bySignal = new Map(signalsResult.results.map((row) => [row.signal, row.devices]));
  const signalKeys = [
    "app_started",
    "project_ready",
    "audio_imported",
    "playback_started",
    "work_completed",
  ];
  const qualityPairs = [
    ["audio_import", "audio_imported", "audio_import_failed"],
    ["project_open", "project_opened", "project_open_failed"],
    ["session_export", "session_exported", "session_export_failed"],
  ] as const;

  return Response.json(
    {
      generatedAt: new Date(generatedAt).toISOString(),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      retentionDays: RETENTION_DAYS,
      // True when the request reached outside the retained data, so the
      // dashboard can say the answer covers less than what was asked for.
      clamped: range.clamped,
      role: auth.role,
      // A guest sees whose token they are holding and when it stops working,
      // so an expiry is never a dashboard that silently stops loading.
      access: auth.role === "guest" ? serialiseToken(auth.token) : null,
      // Echo of what the server accepted. Values it rejected are absent, so a
      // stale bookmark drops the dead filter instead of the whole dashboard.
      filters: Object.fromEntries(FILTER_KEYS.map((key) => [key, filters[key]])),
      appStarts: totals?.appStarts ?? 0,
      activeDeviceDays,
      comparison: previousTotals
        ? {
            appStarts: previousTotals.appStarts,
            activeDeviceDays: previousTotals.devices,
            from: new Date(previous.from).toISOString(),
            to: new Date(previous.to).toISOString(),
          }
        : null,
      activation: signalKeys.map((key) => {
        const devices = bySignal.get(key) ?? 0;
        return { key, devices, rate: rate(devices, activeDeviceDays) };
      }),
      // Reported separately from `engagement` because that array is the picker
      // and stops being filtered by itself the moment a milestone is selected.
      deepSessionRate: rate(byEvent.get("active_30m")?.devices ?? 0, activeDeviceDays),
      features: FEATURE_EVENTS.map((key) => {
        const row = byPickerEvent.get(key);
        return {
          key,
          devices: row?.devices ?? 0,
          events: row?.events ?? 0,
          adoptionRate: rate(row?.devices ?? 0, pickerDeviceDays),
        };
      }).sort((left, right) => right.devices - left.devices),
      quality: qualityPairs.map(([key, successEvent, failureEvent]) => {
        const successes = byEvent.get(successEvent)?.events ?? 0;
        const failures = byEvent.get(failureEvent)?.events ?? 0;
        return {
          key,
          successes,
          failures,
          successRate: rate(successes, successes + failures),
        };
      }),
      engagement: [5, 15, 30, 60].map((minutes) => {
        const devices = byPickerEvent.get(`active_${minutes}m`)?.devices ?? 0;
        return { minutes, devices, rate: rate(devices, pickerDeviceDays) };
      }),
      maturity: {
        installationAge: ageResult.results,
        activeDays: activeDaysResult.results,
      },
      daily: dailyResult.results,
      weekly: {
        weekdays: weekdayRows,
        // Share of reporting device-days that land on a local Sunday. Well
        // above one seventh means LibreTracks is mostly running at services,
        // a flat week means it is mostly running at rehearsals.
        sundayShare: rate(
          weekdayRows[0]?.devices ?? 0,
          weekdayRows.reduce((total, row) => total + row.devices, 0),
        ),
      },
      hourly: Array.from({ length: 24 }, (_, hour) => {
        const key = String(hour).padStart(2, "0");
        return (
          hourlyResult.results.find((row) => row.hour === key) ?? {
            hour: key,
            sessions: 0,
            devices: 0,
          }
        );
      }),
      breakdown: {
        countries: countries.results,
        versions: versions.results,
        operatingSystems: operatingSystems.results,
        deviceClasses: deviceClasses.results,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
};
