/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEMETRY_DB: D1Database;
  ANALYTICS_ADMIN_TOKEN?: string;
}

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

const MIN_ADMIN_TOKEN_LENGTH = 15;
const DAY_MS = 86_400_000;
// Every telemetry insert prunes both tables past this age (see events.ts), so
// no query can reach further back however wide a range the dashboard asks for.
const RETENTION_DAYS = 90;
const PRESET_DAYS = new Set([1, 7, 30, 90]);
// The dashboard builds "last 90 days" against its own clock, so by the time the
// request lands the retention floor has already moved past it by the round trip.
// Only a trim wider than that counts as the range having been cut short.
const CLAMP_TOLERANCE_MS = 60_000;

type Range = { from: number; to: number; clamped: boolean };

async function breakdown(
  db: D1Database,
  column: "app_version" | "os" | "device_class" | "country_code",
  range: Range,
  // Countries are shown as a scrollable ranking next to the map, so the whole
  // ISO 3166-1 range has to fit; the other dimensions stay capped at a top 20.
  limit = 20,
): Promise<BreakdownRow[]> {
  const result = await db
    .prepare(
      `SELECT ${column} AS label, COUNT(*) AS sessions,
              COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
         FROM telemetry_events
        WHERE received_at >= ?1 AND received_at < ?2
        GROUP BY ${column}
        ORDER BY devices DESC, sessions DESC
        LIMIT ?3`,
    )
    .bind(range.from, range.to, limit)
    .all<BreakdownRow>();
  return result.results;
}

function tokenMatches(request: Request, expected?: string): boolean {
  if (!expected || expected.length < MIN_ADMIN_TOKEN_LENGTH) return false;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
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

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  if (
    !env.ANALYTICS_ADMIN_TOKEN ||
    env.ANALYTICS_ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH
  ) {
    return Response.json({ error: "admin_token_not_configured" }, { status: 503 });
  }
  if (!tokenMatches(request, env.ANALYTICS_ADMIN_TOKEN)) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const generatedAt = Date.now();
  const range = resolveRange(new URL(request.url).searchParams, generatedAt);
  const { from, to } = range;
  const span = to - from;
  // The comparison window is the same span immediately before, snapped up to
  // whole days: a partial day (Today, Last 6 hours) then lands on the same
  // clock hours yesterday instead of on the hours right before it.
  const shift = Math.ceil(span / DAY_MS) * DAY_MS;
  const previousFrom = from - shift;
  const previousTo = to - shift;
  // Retention would only feed a truncated previous window, and an invented
  // drop is worse than no comparison at all.
  const comparable = previousFrom >= generatedAt - RETENTION_DAYS * DAY_MS;

  const [
    totals,
    previousTotals,
    eventsResult,
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
  ] =
    await Promise.all([
      env.TELEMETRY_DB.prepare(
        `SELECT COUNT(*) AS appStarts,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND received_at < ?2`,
      )
        .bind(from, to)
        .first<{ appStarts: number; devices: number }>(),
      comparable
        ? env.TELEMETRY_DB.prepare(
            `SELECT COUNT(*) AS appStarts,
                    COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
               FROM telemetry_events
              WHERE received_at >= ?1 AND received_at < ?2`,
          )
            .bind(previousFrom, previousTo)
            .first<{ appStarts: number; devices: number }>()
        : Promise.resolve(null),
      env.TELEMETRY_DB.prepare(
        `SELECT event_name AS event, COUNT(*) AS events,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_product_events
          WHERE received_at >= ?1 AND received_at < ?2
          GROUP BY event_name`,
      )
        .bind(from, to)
        .all<EventRow>(),
      env.TELEMETRY_DB.prepare(
        `WITH signals AS (
           SELECT utc_day, daily_device_token, 'app_started' AS signal
             FROM telemetry_events
            WHERE received_at >= ?1 AND received_at < ?2
           UNION ALL
           SELECT utc_day, daily_device_token,
             CASE
               WHEN event_name IN ('project_created', 'project_opened') THEN 'project_ready'
               WHEN event_name = 'audio_imported' THEN 'audio_imported'
               WHEN event_name = 'playback_started' THEN 'playback_started'
               WHEN event_name IN ('project_saved', 'session_exported') THEN 'work_completed'
             END AS signal
             FROM telemetry_product_events
            WHERE received_at >= ?1 AND received_at < ?2 AND event_name IN (
              'project_created', 'project_opened', 'audio_imported',
              'playback_started', 'project_saved', 'session_exported'
            )
         )
         SELECT signal, COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM signals WHERE signal IS NOT NULL GROUP BY signal`,
      )
        .bind(from, to)
        .all<SignalRow>(),
      env.TELEMETRY_DB.prepare(
        `SELECT installation_age_bucket AS label,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND received_at < ?2
            AND installation_age_bucket != 'unknown'
          GROUP BY installation_age_bucket`,
      )
        .bind(from, to)
        .all<BucketRow>(),
      env.TELEMETRY_DB.prepare(
        `SELECT active_days_bucket AS label,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND received_at < ?2
            AND active_days_bucket != 'unknown'
          GROUP BY active_days_bucket`,
      )
        .bind(from, to)
        .all<BucketRow>(),
      env.TELEMETRY_DB.prepare(
        `WITH starts AS (
           SELECT utc_day AS day, COUNT(DISTINCT daily_device_token) AS activeDevices
             FROM telemetry_events
            WHERE received_at >= ?1 AND received_at < ?2 GROUP BY utc_day
         ), product AS (
           SELECT utc_day AS day,
             COUNT(DISTINCT CASE WHEN event_name IN (
               'project_created', 'project_opened', 'audio_imported',
               'playback_started', 'project_saved', 'session_exported'
             ) THEN daily_device_token END) AS activatedDevices,
             COUNT(DISTINCT CASE WHEN event_name LIKE 'feature_%'
               THEN daily_device_token END) AS featureDevices
             FROM telemetry_product_events
            WHERE received_at >= ?1 AND received_at < ?2 GROUP BY utc_day
         )
         SELECT starts.day, starts.activeDevices,
                COALESCE(product.activatedDevices, 0) AS activatedDevices,
                COALESCE(product.featureDevices, 0) AS featureDevices
           FROM starts LEFT JOIN product ON product.day = starts.day
          ORDER BY starts.day`,
      )
        .bind(from, to)
        .all<DailyRow>(),
      env.TELEMETRY_DB.prepare(
        `SELECT strftime('%H', received_at / 1000, 'unixepoch') AS hour,
                COUNT(*) AS sessions,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND received_at < ?2
          GROUP BY hour ORDER BY hour`,
      )
        .bind(from, to)
        .all<HourlyRow>(),
      // Grouped on the device-reported local weekday, never on utc_day: a
      // Sunday evening service in the Americas is already Monday in UTC.
      env.TELEMETRY_DB.prepare(
        `SELECT local_weekday AS weekday, COUNT(*) AS sessions,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND received_at < ?2 AND local_weekday != 'unknown'
          GROUP BY local_weekday ORDER BY weekday`,
      )
        .bind(from, to)
        .all<WeekdayRow>(),
      breakdown(env.TELEMETRY_DB, "country_code", range, 300),
      breakdown(env.TELEMETRY_DB, "app_version", range),
      breakdown(env.TELEMETRY_DB, "os", range),
      breakdown(env.TELEMETRY_DB, "device_class", range),
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
      appStarts: totals?.appStarts ?? 0,
      activeDeviceDays,
      comparison: previousTotals
        ? {
            appStarts: previousTotals.appStarts,
            activeDeviceDays: previousTotals.devices,
            from: new Date(previousFrom).toISOString(),
            to: new Date(previousTo).toISOString(),
          }
        : null,
      activation: signalKeys.map((key) => {
        const devices = bySignal.get(key) ?? 0;
        return { key, devices, rate: rate(devices, activeDeviceDays) };
      }),
      features: FEATURE_EVENTS.map((key) => {
        const row = byEvent.get(key);
        return {
          key,
          devices: row?.devices ?? 0,
          events: row?.events ?? 0,
          adoptionRate: rate(row?.devices ?? 0, activeDeviceDays),
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
        const devices = byEvent.get(`active_${minutes}m`)?.devices ?? 0;
        return { minutes, devices, rate: rate(devices, activeDeviceDays) };
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
      breakdown: { countries, versions, operatingSystems, deviceClasses },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
};
