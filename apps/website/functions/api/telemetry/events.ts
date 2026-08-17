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
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

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

function response(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function isValidEvent(value: unknown): value is TelemetryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    event.event === "app_started" &&
    (event.consentVersion === undefined || event.consentVersion === 2) &&
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
  if (!isValidEvent(payload)) {
    return response(400, { error: "invalid_event" });
  }

  const now = Date.now();
  const utcDay = new Date(now).toISOString().slice(0, 10);
  const edgeCountry = request.cf?.country;
  const countryCode =
    payload.consentVersion === 2 &&
    typeof edgeCountry === "string" &&
    /^[A-Z]{2}$/.test(edgeCountry)
      ? edgeCountry
      : "XX";

  // A broken client must not flood the table. This deliberately uses only the
  // rotating token; IP addresses and full User-Agent headers are never stored.
  const recent = await env.TELEMETRY_DB.prepare(
    `SELECT COUNT(*) AS count
       FROM telemetry_events
      WHERE daily_device_token = ?1 AND received_at >= ?2`,
  )
    .bind(payload.dailyDeviceToken, now - 86_400_000)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 100) {
    return response(202, { accepted: true });
  }

  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(
      `INSERT INTO telemetry_events
        (received_at, utc_day, event_name, daily_device_token,
         app_version, os, arch, device_class, country_code)
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
    ),
    // Opportunistic retention enforcement. Aggregates older than 90 days are
    // intentionally not kept in this MVP; a scheduled aggregate can be added
    // later without ever retaining device-level rows longer.
    env.TELEMETRY_DB.prepare(
      "DELETE FROM telemetry_events WHERE received_at < ?1",
    ).bind(now - 90 * 86_400_000),
  ]);

  return response(202, { accepted: true });
};
