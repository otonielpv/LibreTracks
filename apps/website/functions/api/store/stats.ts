/// <reference types="@cloudflare/workers-types" />

/**
 * GET /api/store/stats: ratings, downloads and reviews of LibreTracks across
 * the App Store, Google Play and GitHub, for the public site.
 *
 * Ratings and reviews are kept apart on purpose. A rating is a star score,
 * with or without text; a review is a rating that has text. The big numbers
 * (count, average, AggregateRating.ratingCount) come from ratings only, and the
 * reviews only feed the quotes and reviewCount.
 *
 * Every source is cached in D1 with its own lifetime. A request answers from
 * D1 straight away and refreshes at most one stale source in the background,
 * so one invocation never runs into the Workers subrequest limit and a slow
 * store never slows the page.
 */

import seed from "../../../src/data/storeReviews.json";
import { type AppleEnv, type AppleRatings, fetchAppleRatings, syncAppleDownloads } from "./_apple";
import { type GithubEnv, fetchGithubDownloads } from "./_github";
import { type PlayEnv, syncPlayBucket, syncPlayReviewsApi } from "./_play";

type Env = AppleEnv & PlayEnv & GithubEnv & { TELEMETRY_DB: D1Database };

const HOUR = 3_600_000;
/** If a refresh fails, try again after this long instead of a whole TTL. */
const RETRY_AFTER = 20 * 60_000;
/** A source that ran out of subrequest budget ({ pending: true }) continues this soon. */
const CONTINUE_AFTER = 60_000;

type SourceKey = "appleRatings" | "appleDownloads" | "github" | "playReviews" | "playBucket";

const SOURCES: Record<SourceKey, { ttl: number; refresh: (env: Env, previous: unknown) => Promise<unknown> }> = {
  appleRatings: {
    ttl: 6 * HOUR,
    refresh: (_env, previous) => fetchAppleRatings((previous as AppleRatings) ?? {}),
  },
  appleDownloads: {
    ttl: 6 * HOUR,
    refresh: async (env) => {
      const complete = await syncAppleDownloads(env.TELEMETRY_DB, env);
      return { ok: true, pending: !complete };
    },
  },
  github: {
    ttl: 6 * HOUR,
    refresh: async (env) => ({ downloads: await fetchGithubDownloads(env) }),
  },
  playReviews: {
    ttl: 12 * HOUR,
    refresh: async (env) => {
      await syncPlayReviewsApi(env.TELEMETRY_DB, env);
      return { ok: true };
    },
  },
  playBucket: {
    ttl: 12 * HOUR,
    refresh: (env, previous) =>
      syncPlayBucket(env.TELEMETRY_DB, env, (previous as { seen?: Record<string, string> } | null)?.seen ?? {}),
  },
};

type CacheRow = { key: string; json: string; fetched_at: number };

async function refreshOne(env: Env, key: SourceKey, previous: unknown, now: number): Promise<void> {
  const db = env.TELEMETRY_DB;
  const source = SOURCES[key];
  // Claim the source first so concurrent requests do not refresh it too; if
  // this attempt fails, the claim makes the next try happen after RETRY_AFTER.
  await db
    .prepare(
      `INSERT INTO store_cache (key, json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at`,
    )
    .bind(key, JSON.stringify(previous ?? null), now - source.ttl + RETRY_AFTER)
    .run();
  try {
    const value = await source.refresh(env, previous);
    const pending = (value as { pending?: boolean } | null)?.pending === true;
    const fetchedAt = pending ? Date.now() - source.ttl + CONTINUE_AFTER : Date.now();
    await db
      .prepare("UPDATE store_cache SET json = ?, fetched_at = ? WHERE key = ?")
      .bind(JSON.stringify(value), fetchedAt, key)
      .run();
  } catch (error) {
    console.warn(`store stats: ${key} refresh failed`, error);
  }
}

type SeedReview = (typeof seed.reviews)[number];

export type PublicReview = {
  id: string;
  store: "appstore" | "play";
  author: string | null;
  rating: number;
  date: string;
  language: string | null;
  country?: string;
  title?: string;
  text: string;
};

function weightedAverage(parts: { count: number; average: number }[]): number {
  const count = parts.reduce((total, part) => total + part.count, 0);
  if (!count) return 0;
  return parts.reduce((total, part) => total + part.average * part.count, 0) / count;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const db = env.TELEMETRY_DB;
  const now = Date.now();

  const cacheRows = await db.prepare("SELECT key, json, fetched_at FROM store_cache").all<CacheRow>();
  const cache = new Map(cacheRows.results.map((row) => [row.key, row]));
  const read = (key: SourceKey): unknown => {
    const row = cache.get(key);
    return row ? JSON.parse(row.json) : null;
  };

  // Refresh the stalest source, if any, after answering.
  const stale = (Object.keys(SOURCES) as SourceKey[])
    .map((key) => ({ key, age: now - (cache.get(key)?.fetched_at ?? 0) - SOURCES[key].ttl }))
    .filter((entry) => entry.age > 0)
    .sort((a, b) => b.age - a.age)[0];
  if (stale) context.waitUntil(refreshOne(env, stale.key, read(stale.key), now));

  const [downloadRows, playRating, playReviewRows] = await Promise.all([
    db
      .prepare(
        // A day row only counts while its month has no monthly row.
        `SELECT store, SUM(downloads) AS downloads FROM store_downloads d
         WHERE length(period) = 7 OR NOT EXISTS (
           SELECT 1 FROM store_downloads m
           WHERE m.store = d.store AND m.period = substr(d.period, 1, 7))
         GROUP BY store`,
      )
      .all<{ store: string; downloads: number }>(),
    db
      .prepare("SELECT COUNT(*) AS count, AVG(rating) AS average FROM store_play_ratings")
      .first<{ count: number; average: number | null }>(),
    db
      .prepare(
        `SELECT review_id, rating, submitted_day, author, language, text FROM store_play_ratings
         WHERE text IS NOT NULL AND hidden = 0 ORDER BY submitted_day DESC, updated_at DESC`,
      )
      .all<{ review_id: string; rating: number; submitted_day: string; author: string | null; language: string | null; text: string }>(),
  ]);

  const appleCountries = (read("appleRatings") as AppleRatings | null) ?? {};
  const appleParts = Object.values(appleCountries);
  const appstoreRatings = {
    count: appleParts.reduce((total, part) => total + part.count, 0),
    average: weightedAverage(appleParts),
    countries: Object.keys(appleCountries).length,
  };
  const playRatings = { count: playRating?.count ?? 0, average: playRating?.average ?? 0 };

  const downloadsByStore = Object.fromEntries(downloadRows.results.map((row) => [row.store, row.downloads]));
  const github = ((read("github") as { downloads?: number } | null)?.downloads) ?? 0;
  const downloads = {
    appstore: downloadsByStore.appstore ?? 0,
    play: downloadsByStore.play ?? 0,
    github,
    total: (downloadsByStore.appstore ?? 0) + (downloadsByStore.play ?? 0) + github,
  };

  const playReviews: PublicReview[] = playReviewRows.results.map((row) => ({
    id: `play-${row.review_id}`,
    store: "play",
    author: row.author,
    rating: row.rating,
    date: row.submitted_day,
    language: row.language,
    text: row.text,
  }));
  const appstoreReviews: PublicReview[] = seed.reviews
    .filter((review: SeedReview) => review.store === "appstore")
    .map((review: SeedReview) => ({
      id: review.id,
      store: "appstore",
      author: review.author,
      rating: review.rating,
      date: review.date,
      language: review.language,
      country: (review as { country?: string }).country,
      title: (review as { title?: string }).title,
      text: review.text,
    }));
  const reviews = [...appstoreReviews, ...playReviews].sort((a, b) => b.date.localeCompare(a.date));

  const body = {
    updatedAt: new Date(now).toISOString(),
    ratings: {
      count: appstoreRatings.count + playRatings.count,
      average: weightedAverage([appstoreRatings, playRatings]),
      appstore: appstoreRatings,
      play: playRatings,
    },
    downloads,
    reviews: { count: reviews.length, items: reviews },
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
};
