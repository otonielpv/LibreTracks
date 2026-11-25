/// <reference types="@cloudflare/workers-types" />

import { appStoreConnectJwt } from "./_crypto";

export const APP_STORE_ID = "6811346212";
/** First month on the App Store. */
const APPLE_FIRST_MONTH = "2026-09";

/**
 * Storefronts whose ratings are summed. Apple keeps ratings per country and
 * has no global total, so the site adds them up. Each lookup is one
 * subrequest; this list stays well under the Workers limit per invocation.
 * Add a country here when App Store Connect shows ratings from it.
 */
export const APPLE_COUNTRIES = [
  "us", "mx", "es", "co", "ar", "cl", "pe", "ec", "gt", "ve", "bo", "py",
  "uy", "cr", "pa", "do", "hn", "sv", "ni", "br", "pt", "gb", "ca", "de",
  "fr", "it", "au",
];

export type CountryRating = { count: number; average: number };
export type AppleRatings = Record<string, CountryRating>;

/**
 * Reads the public iTunes Lookup API per storefront. A country that fails
 * keeps its previous value, so one bad answer never shrinks the total.
 */
export async function fetchAppleRatings(previous: AppleRatings): Promise<AppleRatings> {
  const next: AppleRatings = { ...previous };
  await Promise.all(
    APPLE_COUNTRIES.map(async (country) => {
      try {
        const response = await fetch(
          `https://itunes.apple.com/lookup?id=${APP_STORE_ID}&country=${country}`,
          { cf: { cacheTtl: 3600 } } as RequestInit,
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          resultCount: number;
          results: { userRatingCount?: number; averageUserRating?: number }[];
        };
        const app = data.results?.[0];
        if (!app) return;
        const count = app.userRatingCount ?? 0;
        if (count > 0) next[country] = { count, average: app.averageUserRating ?? 0 };
        else delete next[country];
      } catch {
        // Keep the previous value for this country.
      }
    }),
  );
  return next;
}

export type AppleEnv = {
  ASC_KEY_ID?: string;
  ASC_ISSUER_ID?: string;
  ASC_PRIVATE_KEY?: string;
  ASC_VENDOR_NUMBER?: string;
};

/** Product types that are a first download of the app (not 7F updates, not 3F redownloads). */
const FIRST_DOWNLOAD_TYPES = new Set(["1", "1F", "1T"]);

async function gunzipText(body: ArrayBuffer): Promise<string> {
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export function sumFirstDownloads(tsv: string): number {
  const [header, ...rows] = tsv.trim().split("\n");
  const columns = header.split("\t");
  const type = columns.indexOf("Product Type Identifier");
  const units = columns.indexOf("Units");
  const appleId = columns.indexOf("Apple Identifier");
  let total = 0;
  for (const row of rows) {
    const cells = row.split("\t");
    if (appleId >= 0 && cells[appleId] && cells[appleId] !== APP_STORE_ID) continue;
    if (!FIRST_DOWNLOAD_TYPES.has(cells[type])) continue;
    total += Number(cells[units]) || 0;
  }
  return total;
}

/** null = no report (Apple answers 404 for a period without sales or not generated yet). */
async function salesReport(
  env: Required<AppleEnv>,
  frequency: "MONTHLY" | "DAILY",
  date: string,
): Promise<number | null> {
  const query = new URLSearchParams({
    "filter[frequency]": frequency,
    "filter[reportType]": "SALES",
    "filter[reportSubType]": "SUMMARY",
    "filter[vendorNumber]": env.ASC_VENDOR_NUMBER,
    "filter[version]": "1_0",
    "filter[reportDate]": date,
  });
  // Apple sometimes answers 401 to a valid token; a fresh one usually works.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const jwt = await appStoreConnectJwt(env.ASC_KEY_ID, env.ASC_ISSUER_ID, env.ASC_PRIVATE_KEY);
    const response = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${query}`, {
      headers: { authorization: `Bearer ${jwt}`, accept: "application/a-gzip" },
    });
    if (response.status === 401) continue;
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`salesReports ${response.status}`);
    return sumFirstDownloads(await gunzipText(await response.arrayBuffer()));
  }
  throw new Error("salesReports 401");
}

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  let [year, month] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

const DAY_MS = 86_400_000;
/** Daily reports show up a day or two late; a 404 younger than this is "not yet". */
const DAILY_REPORT_DELAY_DAYS = 3;
/** Subrequest budget for one sync; the rest waits for the next one. */
const MAX_REPORTS_PER_SYNC = 12;

/**
 * Brings store_downloads up to date for the App Store: one MONTHLY row per
 * closed month and, until Apple publishes that, one row per day. Reports
 * already stored are never fetched again.
 */
/** Returns false when the subrequest budget ran out before everything was fetched. */
export async function syncAppleDownloads(db: D1Database, env: AppleEnv, now = Date.now()): Promise<boolean> {
  if (!env.ASC_KEY_ID || !env.ASC_ISSUER_ID || !env.ASC_PRIVATE_KEY || !env.ASC_VENDOR_NUMBER) {
    throw new Error("App Store Connect secrets missing");
  }
  const credentials = env as Required<AppleEnv>;
  const stored = await db
    .prepare("SELECT period FROM store_downloads WHERE store = 'appstore'")
    .all<{ period: string }>();
  const have = new Set(stored.results.map((row) => row.period));
  const today = new Date(now).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  let budget = MAX_REPORTS_PER_SYNC;

  for (const month of monthsBetween(APPLE_FIRST_MONTH, currentMonth)) {
    if (have.has(month)) continue;
    if (budget <= 0) return false;
    if (month !== currentMonth) {
      budget -= 1;
      const units = await salesReport(credentials, "MONTHLY", month);
      if (units !== null) {
        await db.batch([
          db.prepare("INSERT OR REPLACE INTO store_downloads (store, period, downloads) VALUES ('appstore', ?, ?)").bind(month, units),
          db.prepare("DELETE FROM store_downloads WHERE store = 'appstore' AND period LIKE ?").bind(`${month}-%`),
        ]);
        continue;
      }
    }
    // No monthly report yet: count the month day by day.
    const [year, monthNumber] = month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      if (date >= today) break;
      if (have.has(date)) continue;
      if (budget <= 0) return false;
      budget -= 1;
      const units = await salesReport(credentials, "DAILY", date);
      const ageDays = (now - Date.parse(`${date}T00:00:00Z`)) / DAY_MS;
      if (units === null && ageDays < DAILY_REPORT_DELAY_DAYS) continue;
      await db
        .prepare("INSERT OR REPLACE INTO store_downloads (store, period, downloads) VALUES ('appstore', ?, ?)")
        .bind(date, units ?? 0)
        .run();
    }
  }
  return true;
}
