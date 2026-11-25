/// <reference types="@cloudflare/workers-types" />

import { type ServiceAccount, googleAccessToken } from "./_crypto";

export const PLAY_PACKAGE = "com.libretracks.app";
/** Play Console's export bucket (Download reports, Cloud Storage URI). */
const PLAY_BUCKET = "pubsite_prod_5987518779305662608";

export type PlayEnv = { PLAY_SERVICE_ACCOUNT?: string };

function serviceAccount(env: PlayEnv): ServiceAccount {
  if (!env.PLAY_SERVICE_ACCOUNT) throw new Error("PLAY_SERVICE_ACCOUNT missing");
  return JSON.parse(env.PLAY_SERVICE_ACCOUNT) as ServiceAccount;
}

/** RFC 4180 CSV, enough for Play's exports (quoted fields with commas). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.some((cell) => cell !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      endRow();
    } else field += char;
  }
  endRow();
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) =>
    Object.fromEntries(header.map((name, i) => [name.trim(), (cells[i] ?? "").trim()])),
  );
}

/** Play exports are UTF-16LE with a BOM; tolerate UTF-8 too. */
export function decodePlayCsv(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const utf16 = view[0] === 0xff && view[1] === 0xfe;
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
}

export type PlayRatingRow = {
  reviewId: string;
  rating: number;
  submittedDay: string;
  updatedAt: number;
  author: string | null;
  language: string | null;
  version: string | null;
  text: string | null;
};

function upsertRating(db: D1Database, row: PlayRatingRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO store_play_ratings
         (review_id, rating, submitted_day, updated_at, author, language, version, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET
         rating = excluded.rating,
         updated_at = excluded.updated_at,
         author = COALESCE(excluded.author, author),
         language = COALESCE(excluded.language, language),
         version = COALESCE(excluded.version, version),
         text = COALESCE(excluded.text, text)
       WHERE excluded.updated_at >= updated_at`,
    )
    .bind(
      row.reviewId,
      row.rating,
      row.submittedDay,
      row.updatedAt,
      row.author,
      row.language,
      row.version,
      row.text,
    );
}

/** One row of a monthly reviews_<package>_YYYYMM.csv. Ratings without text have no link. */
export function ratingFromCsv(record: Record<string, string>): PlayRatingRow | null {
  const rating = Number(record["Star Rating"]);
  const submitted = Number(record["Review Submit Millis Since Epoch"]);
  if (!(rating >= 1 && rating <= 5) || !submitted) return null;
  const updated = Number(record["Review Last Update Millis Since Epoch"]) || submitted;
  const id = /reviewId=([0-9a-f-]+)/i.exec(record["Review Link"] ?? "")?.[1] ?? `csv-${submitted}`;
  const text = record["Review Text"] ?? "";
  return {
    reviewId: id,
    rating,
    submittedDay: new Date(submitted).toISOString().slice(0, 10),
    updatedAt: updated,
    author: null,
    language: record["Reviewer Language"] || null,
    version: record["App Version Name"] || null,
    text: text || null,
  };
}

type ApiReview = {
  reviewId: string;
  authorName?: string;
  comments: {
    userComment?: {
      text?: string;
      starRating: number;
      reviewerLanguage?: string;
      appVersionName?: string;
      lastModified: { seconds: string };
    };
  }[];
};

/**
 * Text reviews of the last 7 days from the Publishing API (that is all it
 * keeps), accumulated into store_play_ratings. Ratings without text only
 * arrive through the bucket CSVs.
 */
export async function syncPlayReviewsApi(db: D1Database, env: PlayEnv): Promise<void> {
  const token = await googleAccessToken(serviceAccount(env), [
    "https://www.googleapis.com/auth/androidpublisher",
  ]);
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}/reviews`;
  const statements: D1PreparedStatement[] = [];
  let url: string | null = `${base}?maxResults=100`;
  for (let page = 0; url && page < 5; page += 1) {
    const response: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`play reviews ${response.status}`);
    const data = (await response.json()) as {
      reviews?: ApiReview[];
      tokenPagination?: { nextPageToken?: string };
    };
    for (const review of data.reviews ?? []) {
      const comment = review.comments.find((entry) => entry.userComment)?.userComment;
      if (!comment) continue;
      const updatedAt = Number(comment.lastModified.seconds) * 1000;
      statements.push(
        upsertRating(db, {
          reviewId: review.reviewId,
          rating: comment.starRating,
          submittedDay: new Date(updatedAt).toISOString().slice(0, 10),
          updatedAt,
          author: review.authorName?.trim() || null,
          language: comment.reviewerLanguage?.split(/[-_]/)[0] ?? null,
          version: comment.appVersionName ?? null,
          text: comment.text?.trim() || null,
        }),
      );
    }
    const next = data.tokenPagination?.nextPageToken;
    url = next ? `${base}?maxResults=100&token=${encodeURIComponent(next)}` : null;
  }
  if (statements.length) await db.batch(statements);
}

type BucketObject = { name: string; updated: string };
/** Downloads per sync; the rest waits for the next one. */
const MAX_BUCKET_FILES_PER_SYNC = 8;

/**
 * Reads the monthly install and review CSVs Play Console drops in its bucket.
 * Installs become one store_downloads row per month ("Daily User Installs",
 * first installs per user, the same idea as Apple's 1F). Review rows upsert
 * every rating, with or without text. `seen` remembers each file's `updated`
 * stamp so unchanged files are not downloaded again.
 */
export async function syncPlayBucket(
  db: D1Database,
  env: PlayEnv,
  seen: Record<string, string>,
): Promise<{ seen: Record<string, string>; pending: boolean }> {
  const token = await googleAccessToken(serviceAccount(env), [
    "https://www.googleapis.com/auth/devstorage.read_only",
  ]);
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const list = async (prefix: string): Promise<BucketObject[]> => {
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${PLAY_BUCKET}/o?prefix=${encodeURIComponent(prefix)}&maxResults=500`,
      auth,
    );
    if (!response.ok) throw new Error(`play bucket ${response.status}`);
    return ((await response.json()) as { items?: BucketObject[] }).items ?? [];
  };
  const objects = [
    ...(await list(`stats/installs/installs_${PLAY_PACKAGE}_`)).filter((object) =>
      object.name.endsWith("_overview.csv"),
    ),
    ...(await list(`reviews/reviews_${PLAY_PACKAGE}_`)),
  ];
  const next = { ...seen };
  let budget = MAX_BUCKET_FILES_PER_SYNC;
  for (const object of objects) {
    if (next[object.name] === object.updated) continue;
    if (budget <= 0) return { seen: next, pending: true };
    budget -= 1;
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${PLAY_BUCKET}/o/${encodeURIComponent(object.name)}?alt=media`,
      auth,
    );
    if (!response.ok) throw new Error(`play bucket file ${response.status}`);
    const records = parseCsv(decodePlayCsv(await response.arrayBuffer()));
    if (object.name.startsWith("stats/installs/")) {
      const month = /_(\d{4})(\d{2})_overview\.csv$/.exec(object.name);
      if (month) {
        const installs = records.reduce(
          (total, record) =>
            total + (Number(record["Daily User Installs"] ?? record["Daily Device Installs"]) || 0),
          0,
        );
        await db
          .prepare("INSERT OR REPLACE INTO store_downloads (store, period, downloads) VALUES ('play', ?, ?)")
          .bind(`${month[1]}-${month[2]}`, installs)
          .run();
      }
    } else {
      const statements: D1PreparedStatement[] = [];
      for (const record of records) {
        const row = ratingFromCsv(record);
        if (!row) continue;
        statements.push(upsertRating(db, row));
        // A rating that later got text gains a link and a real id.
        if (!row.reviewId.startsWith("csv-")) {
          statements.push(
            db
              .prepare("DELETE FROM store_play_ratings WHERE review_id = ?")
              .bind(`csv-${record["Review Submit Millis Since Epoch"]}`),
          );
        }
      }
      if (statements.length) await db.batch(statements);
    }
    next[object.name] = object.updated;
  }
  return { seen: next, pending: false };
}
