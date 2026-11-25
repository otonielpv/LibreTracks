/**
 * Store ratings, downloads and reviews at build time.
 *
 * The numbers live behind the Pages Function /api/store/stats (see
 * functions/api/store/stats.ts). The build reads them from production so the
 * HTML that search engines index already carries real figures, and the page
 * then refreshes them in the browser, since the site is only redeployed at
 * each release. Without network or before the first deploy of the Function,
 * the build falls back to the last known snapshot and the seeded reviews.
 *
 * Ratings and reviews are different things: `ratings` counts every star score
 * (with or without text), `reviews` holds only the ones with text.
 */
import snapshot from "../data/storeStatsSnapshot.json";
import seed from "../data/storeReviews.json";

export type StoreReview = {
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

export type StoreStats = {
  updatedAt: string;
  ratings: {
    count: number;
    average: number;
    appstore: { count: number; average: number; countries: number };
    play: { count: number; average: number };
  };
  downloads: { appstore: number; play: number; github: number; total: number };
  reviews: { count: number; items: StoreReview[] };
};

export const STORE_STATS_ENDPOINT = "https://libretracks.com/api/store/stats";

function fallback(): StoreStats {
  const items = (seed.reviews as StoreReview[]).slice().sort((a, b) => b.date.localeCompare(a.date));
  const { $comment: _comment, ...numbers } = snapshot;
  return { ...numbers, reviews: { count: items.length, items } };
}

function isValid(data: unknown): data is StoreStats {
  const stats = data as StoreStats;
  return (
    typeof stats?.ratings?.count === "number" &&
    typeof stats?.downloads?.total === "number" &&
    Array.isArray(stats?.reviews?.items)
  );
}

let pending: Promise<StoreStats> | null = null;

/** One fetch per build, shared by every page. */
export function loadStoreStats(): Promise<StoreStats> {
  pending ??= (async () => {
    const known = fallback();
    try {
      const response = await fetch(STORE_STATS_ENDPOINT, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const live = await response.json();
      if (!isValid(live)) throw new Error("unexpected shape");
      // Never publish fewer than the last known numbers: a store that failed
      // to answer reads as zero in the API until its next refresh.
      return live.ratings.count >= known.ratings.count && live.downloads.total >= known.downloads.total
        ? live
        : known;
    } catch (error) {
      console.warn(`[storeStats] using the snapshot: ${error instanceof Error ? error.message : error}`);
      return known;
    }
  })();
  return pending;
}

/** Reviews worth quoting: 4 stars or more, the page's language first, then the longest. */
export function pickQuotes(reviews: StoreReview[], lang: string, limit: number): StoreReview[] {
  const language = lang === "pt" ? "es" : lang;
  const good = reviews.filter((review) => review.rating >= 4 && review.text.trim().length >= 20);
  const score = (review: StoreReview) =>
    (review.language === language ? 1000 : 0) + Math.min(review.text.length, 400) + (review.title ? 40 : 0);
  const sorted = good.slice().sort((a, b) => score(b) - score(a));
  // Alternate stores so both show up.
  const appstore = sorted.filter((review) => review.store === "appstore");
  const play = sorted.filter((review) => review.store === "play");
  const mixed: StoreReview[] = [];
  while (mixed.length < limit && (appstore.length || play.length)) {
    const next = (mixed.length % 2 === 0 ? appstore.shift() ?? play.shift() : play.shift() ?? appstore.shift())!;
    mixed.push(next);
  }
  return mixed;
}
