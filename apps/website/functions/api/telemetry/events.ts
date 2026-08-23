/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEMETRY_DB: D1Database;
}

type TelemetryEvent = {
  event: string;
  consentVersion?: number;
  version: string;
  dailyDeviceToken: string;
  os: string;
  arch: string;
  deviceClass: string;
  installationAgeBucket?: string;
  activeDaysBucket?: string;
  localWeekday?: string;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const PRODUCT_EVENTS = new Set([
  "project_created",
  "project_opened",
  "audio_imported",
  "audio_import_failed",
  "playback_started",
  "project_saved",
  "session_exported",
  "session_export_failed",
  "project_open_failed",
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
const ALLOWED_OS = new Set([
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
  "unknown",
]);
const ALLOWED_ARCH = new Set(["x86_64", "arm64", "unknown"]);
const ALLOWED_DEVICE_CLASS = new Set([
  "desktop",
  "mobile",
  "tablet",
  "unknown",
]);
const INSTALLATION_AGE_BUCKETS = new Set([
  "day_0",
  "days_1_7",
  "days_8_30",
  "days_31_90",
  "days_91_plus",
]);
const ACTIVE_DAYS_BUCKETS = new Set(["1", "2_3", "4_7", "8_30", "31_plus"]);
// "0" is Sunday, matching both Date.getDay() and SQLite's strftime('%w').
const LOCAL_WEEKDAYS = new Set(["0", "1", "2", "3", "4", "5", "6"]);

function response(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function isValidEvent(value: unknown): value is TelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const eventName = typeof event.event === "string" ? event.event : "";
  const consentVersion = event.consentVersion;
  const isAppStart = eventName === "app_started";
  const isProductEvent = PRODUCT_EVENTS.has(eventName) && consentVersion === 3;
  const profileIsValid =
    consentVersion !== 3 ||
    !isAppStart ||
    (typeof event.installationAgeBucket === "string" &&
      INSTALLATION_AGE_BUCKETS.has(event.installationAgeBucket) &&
      typeof event.activeDaysBucket === "string" &&
      ACTIVE_DAYS_BUCKETS.has(event.activeDaysBucket));

  const weekdayIsValid =
    event.localWeekday === undefined ||
    (typeof event.localWeekday === "string" &&
      LOCAL_WEEKDAYS.has(event.localWeekday));

  return (
    (isAppStart || isProductEvent) &&
    weekdayIsValid &&
    (consentVersion === undefined || consentVersion === 2 || consentVersion === 3) &&
    profileIsValid &&
    typeof event.version === "string" &&
    /^[0-9A-Za-z.+_-]{1,32}$/.test(event.version) &&
    typeof event.dailyDeviceToken === "string" &&
    /^[a-f0-9]{64}$/.test(event.dailyDeviceToken) &&
    typeof event.os === "string" &&
    ALLOWED_OS.has(event.os) &&
    typeof event.arch === "string" &&
    ALLOWED_ARCH.has(event.arch) &&
    typeof event.deviceClass === "string" &&
    ALLOWED_DEVICE_CLASS.has(event.deviceClass)
  );
}

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 2048) return response(413, { error: "payload_too_large" });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return response(400, { error: "invalid_json" });
  }
  if (!isValidEvent(payload)) return response(400, { error: "invalid_event" });

  const now = Date.now();
  const utcDay = new Date(now).toISOString().slice(0, 10);
  const edgeCountry = request.cf?.country;
  const countryCode =
    (payload.consentVersion ?? 0) >= 2 &&
    typeof edgeCountry === "string" &&
    /^[A-Z]{2}$/.test(edgeCountry)
      ? edgeCountry
      : "XX";
  const isAppStart = payload.event === "app_started";
  const table = isAppStart ? "telemetry_events" : "telemetry_product_events";
  const limit = isAppStart ? 100 : 60;

  // Per-token caps limit broken or hostile clients without retaining an IP.
  const recent = await env.TELEMETRY_DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}
      WHERE daily_device_token = ?1 AND received_at >= ?2`,
  )
    .bind(payload.dailyDeviceToken, now - 86_400_000)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= limit) return response(202, { accepted: true });

  const insert = isAppStart
    ? env.TELEMETRY_DB.prepare(
        `INSERT INTO telemetry_events
          (received_at, utc_day, event_name, daily_device_token, app_version,
           os, arch, device_class, country_code, installation_age_bucket,
           active_days_bucket, local_weekday)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        now,
        utcDay,
        payload.event,
        payload.dailyDeviceToken,
        payload.version,
        payload.os,
        payload.arch,
        payload.deviceClass,
        countryCode,
        payload.installationAgeBucket ?? "unknown",
        payload.activeDaysBucket ?? "unknown",
        payload.localWeekday ?? "unknown",
      )
    : env.TELEMETRY_DB.prepare(
        `INSERT INTO telemetry_product_events
          (received_at, utc_day, event_name, daily_device_token, app_version,
           os, arch, device_class, country_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        now,
        utcDay,
        payload.event,
        payload.dailyDeviceToken,
        payload.version,
        payload.os,
        payload.arch,
        payload.deviceClass,
        countryCode,
      );

  await env.TELEMETRY_DB.batch([
    insert,
    env.TELEMETRY_DB.prepare(
      "DELETE FROM telemetry_events WHERE received_at < ?1",
    ).bind(now - 90 * 86_400_000),
    env.TELEMETRY_DB.prepare(
      "DELETE FROM telemetry_product_events WHERE received_at < ?1",
    ).bind(now - 90 * 86_400_000),
  ]);

  return response(202, { accepted: true });
};
