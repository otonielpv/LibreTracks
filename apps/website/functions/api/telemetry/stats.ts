/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEMETRY_DB: D1Database;
}

type CountRow = { sessions: number; devices: number };
type BreakdownRow = { label: string; sessions: number; devices: number };
type TimelineRow = { period: string; sessions: number; devices: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PUBLIC_GROUP_MINIMUM = 5;

async function totals(db: D1Database, since: number): Promise<CountRow> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
         FROM telemetry_events
        WHERE received_at >= ?1`,
    )
    .bind(since)
    .first<CountRow>();
  return { sessions: row?.sessions ?? 0, devices: row?.devices ?? 0 };
}

async function breakdown(
  db: D1Database,
  column: "app_version" | "os" | "arch" | "device_class" | "country_code",
  since: number,
): Promise<BreakdownRow[]> {
  const result = await db
    .prepare(
      `SELECT ${column} AS label,
              COUNT(*) AS sessions,
              COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
         FROM telemetry_events
        WHERE received_at >= ?1
        GROUP BY ${column}
        ORDER BY devices DESC, sessions DESC
        LIMIT 20`,
    )
    .bind(since)
    .all<BreakdownRow>();

  return result.results.filter((row) => row.devices >= PUBLIC_GROUP_MINIMUM);
}

async function timeline(
  db: D1Database,
  unit: "hour" | "day",
  start: number,
  points: number,
): Promise<Array<TimelineRow & { suppressed: boolean }>> {
  const periodSql =
    unit === "hour"
      ? "strftime('%Y-%m-%dT%H:00:00Z', received_at / 1000, 'unixepoch')"
      : "utc_day";
  const result = await db
    .prepare(
      `SELECT ${periodSql} AS period,
              COUNT(*) AS sessions,
              COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
         FROM telemetry_events
        WHERE received_at >= ?1
        GROUP BY period
        ORDER BY period`,
    )
    .bind(start)
    .all<TimelineRow>();
  const byPeriod = new Map(result.results.map((row) => [row.period, row]));
  const step = unit === "hour" ? HOUR_MS : DAY_MS;

  return Array.from({ length: points }, (_, index) => {
    const timestamp = start + index * step;
    const period =
      unit === "hour"
        ? new Date(timestamp).toISOString().slice(0, 13) + ":00:00Z"
        : new Date(timestamp).toISOString().slice(0, 10);
    const row = byPeriod.get(period) ?? { period, sessions: 0, devices: 0 };
    const suppressed = row.devices > 0 && row.devices < PUBLIC_GROUP_MINIMUM;
    return {
      period,
      sessions: suppressed ? 0 : row.sessions,
      devices: suppressed ? 0 : row.devices,
      suppressed,
    };
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request, waitUntil }) => {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const generatedAt = Date.now();
  const currentUtcHour = Math.floor(generatedAt / HOUR_MS) * HOUR_MS;
  const currentUtcDay = Math.floor(generatedAt / DAY_MS) * DAY_MS;
  const hourlyStart = currentUtcHour - 23 * HOUR_MS;
  const dailyStart = currentUtcDay - 29 * DAY_MS;
  const breakdownStart = generatedAt - 30 * DAY_MS;

  const [
    last24Hours,
    last7Days,
    last30Days,
    hourly,
    daily,
    versions,
    operatingSystems,
    architectures,
    deviceClasses,
    countries,
  ] = await Promise.all([
    totals(env.TELEMETRY_DB, generatedAt - DAY_MS),
    totals(env.TELEMETRY_DB, generatedAt - 7 * DAY_MS),
    totals(env.TELEMETRY_DB, generatedAt - 30 * DAY_MS),
    timeline(env.TELEMETRY_DB, "hour", hourlyStart, 24),
    timeline(env.TELEMETRY_DB, "day", dailyStart, 30),
    breakdown(env.TELEMETRY_DB, "app_version", breakdownStart),
    breakdown(env.TELEMETRY_DB, "os", breakdownStart),
    breakdown(env.TELEMETRY_DB, "arch", breakdownStart),
    breakdown(env.TELEMETRY_DB, "device_class", breakdownStart),
    breakdown(env.TELEMETRY_DB, "country_code", breakdownStart),
  ]);

  const response = Response.json(
    {
      generatedAt: new Date(generatedAt).toISOString(),
      minimumPublicCohort: PUBLIC_GROUP_MINIMUM,
      metrics: { last24Hours, last7Days, last30Days },
      timeline: { hourly, daily },
      breakdownWindowDays: 30,
      breakdown: {
        versions,
        operatingSystems,
        architectures,
        deviceClasses,
        countries,
      },
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    },
  );
  waitUntil(cache.put(request, response.clone()));
  return response;
};
