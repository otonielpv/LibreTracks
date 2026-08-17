/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEMETRY_DB: D1Database;
  ANALYTICS_ADMIN_TOKEN?: string;
}

type EventRow = { event: string; events: number; devices: number };
type SignalRow = { signal: string; devices: number };
type BucketRow = { label: string; devices: number };
type DailyRow = {
  day: string;
  activeDevices: number;
  activatedDevices: number;
  featureDevices: number;
};

const FEATURE_EVENTS = [
  "feature_compact_view",
  "feature_metronome",
  "feature_voice_guide",
  "feature_ambient_pads",
  "feature_automation",
  "feature_warp",
  "feature_midi",
  "feature_remote_panel",
] as const;

const MIN_ADMIN_TOKEN_LENGTH = 15;

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

  const requestedDays = Number(new URL(request.url).searchParams.get("days") ?? "30");
  const windowDays = requestedDays === 7 || requestedDays === 90 ? requestedDays : 30;
  const generatedAt = Date.now();
  const since = generatedAt - windowDays * 86_400_000;

  const [totals, eventsResult, signalsResult, ageResult, activeDaysResult, dailyResult] =
    await Promise.all([
      env.TELEMETRY_DB.prepare(
        `SELECT COUNT(*) AS appStarts,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1`,
      )
        .bind(since)
        .first<{ appStarts: number; devices: number }>(),
      env.TELEMETRY_DB.prepare(
        `SELECT event_name AS event, COUNT(*) AS events,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_product_events
          WHERE received_at >= ?1
          GROUP BY event_name`,
      )
        .bind(since)
        .all<EventRow>(),
      env.TELEMETRY_DB.prepare(
        `WITH signals AS (
           SELECT utc_day, daily_device_token, 'app_started' AS signal
             FROM telemetry_events WHERE received_at >= ?1
           UNION ALL
           SELECT utc_day, daily_device_token,
             CASE
               WHEN event_name IN ('project_created', 'project_opened') THEN 'project_ready'
               WHEN event_name = 'audio_imported' THEN 'audio_imported'
               WHEN event_name = 'playback_started' THEN 'playback_started'
               WHEN event_name IN ('project_saved', 'session_exported') THEN 'work_completed'
             END AS signal
             FROM telemetry_product_events
            WHERE received_at >= ?1 AND event_name IN (
              'project_created', 'project_opened', 'audio_imported',
              'playback_started', 'project_saved', 'session_exported'
            )
         )
         SELECT signal, COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM signals WHERE signal IS NOT NULL GROUP BY signal`,
      )
        .bind(since)
        .all<SignalRow>(),
      env.TELEMETRY_DB.prepare(
        `SELECT installation_age_bucket AS label,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND installation_age_bucket != 'unknown'
          GROUP BY installation_age_bucket`,
      )
        .bind(since)
        .all<BucketRow>(),
      env.TELEMETRY_DB.prepare(
        `SELECT active_days_bucket AS label,
                COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
           FROM telemetry_events
          WHERE received_at >= ?1 AND active_days_bucket != 'unknown'
          GROUP BY active_days_bucket`,
      )
        .bind(since)
        .all<BucketRow>(),
      env.TELEMETRY_DB.prepare(
        `WITH starts AS (
           SELECT utc_day AS day, COUNT(DISTINCT daily_device_token) AS activeDevices
             FROM telemetry_events WHERE received_at >= ?1 GROUP BY utc_day
         ), product AS (
           SELECT utc_day AS day,
             COUNT(DISTINCT CASE WHEN event_name IN (
               'project_created', 'project_opened', 'audio_imported',
               'playback_started', 'project_saved', 'session_exported'
             ) THEN daily_device_token END) AS activatedDevices,
             COUNT(DISTINCT CASE WHEN event_name LIKE 'feature_%'
               THEN daily_device_token END) AS featureDevices
             FROM telemetry_product_events WHERE received_at >= ?1 GROUP BY utc_day
         )
         SELECT starts.day, starts.activeDevices,
                COALESCE(product.activatedDevices, 0) AS activatedDevices,
                COALESCE(product.featureDevices, 0) AS featureDevices
           FROM starts LEFT JOIN product ON product.day = starts.day
          ORDER BY starts.day`,
      )
        .bind(since)
        .all<DailyRow>(),
    ]);

  const activeDeviceDays = totals?.devices ?? 0;
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
      windowDays,
      appStarts: totals?.appStarts ?? 0,
      activeDeviceDays,
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
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
};
