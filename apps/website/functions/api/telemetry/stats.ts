/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEMETRY_DB: D1Database;
}

type CountRow = { sessions: number; devices: number };
type BreakdownRow = { label: string; sessions: number; devices: number };

const PUBLIC_GROUP_MINIMUM = 5;

async function breakdown(
  db: D1Database,
  column: "app_version" | "os" | "arch" | "device_class",
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
        ORDER BY devices DESC, sessions DESC`,
    )
    .bind(since)
    .all<BreakdownRow>();

  // Small cohorts are not public: a lone user on an unusual platform/version
  // should never become visible through the dashboard.
  return result.results.filter((row) => row.devices >= PUBLIC_GROUP_MINIMUM);
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const generatedAt = Date.now();
  const since = generatedAt - 86_400_000;
  const totals = await env.TELEMETRY_DB.prepare(
    `SELECT COUNT(*) AS sessions,
            COUNT(DISTINCT utc_day || ':' || daily_device_token) AS devices
       FROM telemetry_events
      WHERE received_at >= ?1`,
  )
    .bind(since)
    .first<CountRow>();

  const [versions, operatingSystems, architectures, deviceClasses] =
    await Promise.all([
      breakdown(env.TELEMETRY_DB, "app_version", since),
      breakdown(env.TELEMETRY_DB, "os", since),
      breakdown(env.TELEMETRY_DB, "arch", since),
      breakdown(env.TELEMETRY_DB, "device_class", since),
    ]);

  return Response.json(
    {
      generatedAt: new Date(generatedAt).toISOString(),
      windowHours: 24,
      sessions: totals?.sessions ?? 0,
      approximateDevices: totals?.devices ?? 0,
      activeDevicesAreApproximate: true,
      minimumPublicCohort: PUBLIC_GROUP_MINIMUM,
      breakdown: { versions, operatingSystems, architectures, deviceClasses },
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    },
  );
};
