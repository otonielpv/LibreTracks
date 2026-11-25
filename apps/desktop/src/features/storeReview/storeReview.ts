/**
 * When to ask for an App Store / Google Play rating.
 *
 * Hard rule from the product: NEVER while audio is playing. This module only
 * asks at calm moments (a session finished opening, audio was added, the user
 * saved by hand), waits a moment, checks the transport again, and then hands
 * over to the backend, which does the authoritative check (transport, vamp,
 * pads, master output meter) and refuses if anything may be sounding. See
 * commands/store_review.rs.
 *
 * Beyond that it only asks people who already use the app: a few distinct
 * days of use and a few good moments, and never more often than every
 * REQUEST_INTERVAL_DAYS. iOS and Play add their own limits on top and may
 * still decide not to show the sheet.
 */
import {
  isAndroidApp,
  isIOSApp,
  requestStoreReview,
  type StoreReviewOutcome,
} from "@libretracks/shared/desktopApi";

import { useTransportStore } from "../transport/store";

export type StoreReviewMoment = "sessionOpened" | "audioAdded" | "projectSaved";

export const STORE_REVIEW_STORAGE_KEY = "libretracks.storeReview.v1";
export const MIN_ACTIVE_DAYS = 3;
export const MIN_MOMENTS = 5;
export const REQUEST_INTERVAL_DAYS = 120;
/** Lets the UI settle (busy overlay, toasts) and the user react first. */
export const SETTLE_DELAY_MS = 2500;

const DAY_MS = 24 * 60 * 60 * 1000;

export type StoreReviewState = {
  /** Distinct local days with at least one moment, newest last. */
  activeDays: string[];
  moments: number;
  lastRequestAt: number | null;
};

type Deps = {
  isStoreBuild: () => boolean;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  isTransportQuiet: () => boolean;
  request: () => Promise<StoreReviewOutcome>;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
};

const EMPTY_STATE: StoreReviewState = { activeDays: [], moments: 0, lastRequestAt: null };

export function isTransportQuiet(): boolean {
  const playback = useTransportStore.getState().playback;
  if (!playback) return true;
  return (
    playback.playbackState !== "playing" &&
    !playback.songGapVamp &&
    !playback.fadingToStop
  );
}

const defaultDeps: Deps = {
  isStoreBuild: () => isIOSApp || isAndroidApp,
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isTransportQuiet,
  request: requestStoreReview,
  storage: typeof localStorage === "undefined" ? null : localStorage,
};

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function readStoreReviewState(
  storage: Deps["storage"] = defaultDeps.storage,
): StoreReviewState {
  try {
    const raw = storage?.getItem(STORE_REVIEW_STORAGE_KEY);
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<StoreReviewState>;
    return {
      activeDays: Array.isArray(parsed.activeDays)
        ? parsed.activeDays.filter((day): day is string => typeof day === "string")
        : [],
      moments: typeof parsed.moments === "number" ? parsed.moments : 0,
      lastRequestAt: typeof parsed.lastRequestAt === "number" ? parsed.lastRequestAt : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeState(storage: Deps["storage"], state: StoreReviewState) {
  try {
    storage?.setItem(STORE_REVIEW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: worst case we ask a bit later or not at all.
  }
}

export function isEligible(state: StoreReviewState, now: number): boolean {
  if (state.activeDays.length < MIN_ACTIVE_DAYS) return false;
  if (state.moments < MIN_MOMENTS) return false;
  if (state.lastRequestAt === null) return true;
  return now - state.lastRequestAt >= REQUEST_INTERVAL_DAYS * DAY_MS;
}

/** At most one request in flight, and one per app run. */
let pending = false;
let requestedThisRun = false;

/** Tests only. */
export function resetStoreReviewRunState() {
  pending = false;
  requestedThisRun = false;
}

/**
 * Record a calm, positive moment and, if the user qualifies, ask for a rating
 * once the transport is quiet. Never throws; fire and forget.
 */
export async function noteStoreReviewMoment(
  _moment: StoreReviewMoment,
  overrides: Partial<Deps> = {},
): Promise<StoreReviewOutcome | "skipped"> {
  const deps = { ...defaultDeps, ...overrides };
  if (!deps.isStoreBuild()) return "skipped";
  try {
    const now = deps.now();
    const state = readStoreReviewState(deps.storage);
    const today = localDay(now);
    const activeDays = state.activeDays.includes(today)
      ? state.activeDays
      : [...state.activeDays, today].slice(-30);
    const next: StoreReviewState = { ...state, activeDays, moments: state.moments + 1 };
    writeState(deps.storage, next);

    if (pending || requestedThisRun || !isEligible(next, now)) return "skipped";
    pending = true;
    try {
      await deps.wait(SETTLE_DELAY_MS);
      // Cheap early-out; the backend repeats this and checks pads and the
      // output meter too.
      if (!deps.isTransportQuiet()) return "audioActive";
      const outcome = await deps.request();
      if (outcome === "requested") {
        requestedThisRun = true;
        writeState(deps.storage, {
          ...readStoreReviewState(deps.storage),
          lastRequestAt: deps.now(),
        });
      }
      return outcome;
    } finally {
      pending = false;
    }
  } catch {
    return "skipped";
  }
}
