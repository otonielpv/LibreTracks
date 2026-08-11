import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  COMPACT_COLUMN_DEFAULT_WIDTH_REM,
  COMPACT_COLUMN_MAX_WIDTH_REM,
  COMPACT_COLUMN_MIN_WIDTH_REM,
} from "@libretracks/shared/models";

/** Pixels per rem, read from the document root so the drag maps 1:1 with the
 * pointer even when the user has changed the browser/app font size. Falls back
 * to the CSS default when the computed value is unusable (jsdom, mid-boot). */
function rootFontSizePx(): number {
  if (typeof window === "undefined") return 16;
  const parsed = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

/**
 * Constrain a width to what a column may actually be.
 *
 * The floor is the "Song 1" baseline — the width that fits the default song
 * name plus every badge — NOT the wider-open COMPACT_COLUMN_MIN_WIDTH_REM.
 * A column narrower than its own header reads as broken, so dragging simply
 * stops there rather than letting the user squeeze past it.
 *
 * COMPACT_COLUMN_MIN_WIDTH_REM stays the absolute backstop the backend
 * validates against: a session hand-edited (or written by another build) to
 * something narrower still loads, it just can't be produced from the UI.
 */
export function clampColumnWidthRem(widthRem: number): number {
  if (!Number.isFinite(widthRem)) return COMPACT_COLUMN_DEFAULT_WIDTH_REM;
  return Math.min(
    COMPACT_COLUMN_MAX_WIDTH_REM,
    Math.max(baselineColumnWidthRem(), widthRem),
  );
}

/** Below this width the BPM badge is dropped from the song header — it is
 * secondary information (the toolbar shows the tempo too) and at this size it
 * only steals room from the song's name.
 *
 * These thresholds sit BELOW the baseline floor that `clampColumnWidthRem`
 * now enforces, so a column dragged in the UI no longer reaches them. They
 * are kept because a session saved by an older build (or hand-edited) can
 * still carry a narrower width, and such a column must degrade gracefully
 * rather than render badges over a squashed title. */
export const COMPACT_COLUMN_NARROW_WIDTH_REM = 9;
/** Below this the key badge goes too, leaving just the play button and the
 * (ellipsized) song name. */
export const COMPACT_COLUMN_VERY_NARROW_WIDTH_REM = 7.5;

/** Density class for a column of the given width, or "" at normal widths.
 * Drives which header badges survive; see the `is-narrow` rules in
 * styles.css. Kept here so the thresholds sit beside the width logic and can
 * be unit-tested without rendering. */
export function columnDensityClass(widthRem: number): string {
  if (widthRem <= COMPACT_COLUMN_VERY_NARROW_WIDTH_REM) {
    return "is-narrow is-very-narrow";
  }
  if (widthRem <= COMPACT_COLUMN_NARROW_WIDTH_REM) {
    return "is-narrow";
  }
  return "";
}

/** Font shorthand of `.lt-compact-song-name`, kept in sync with styles.css.
 * Used to measure a title off-screen; a mismatch only shifts the auto width a
 * little, it can't break the layout (the name ellipsizes either way). */
const SONG_NAME_FONT = '600 11px "Space Grotesk", sans-serif';
/** Letter-spacing of `.lt-compact-song-name` (0.08em at 11px). canvas
 * measureText ignores letter-spacing, so it is added back per character. */
const SONG_NAME_LETTER_SPACING_PX = 11 * 0.08;
/** Everything in the header row that is NOT the title. Taken from the
 * rendered header rather than guessed: play button 22.4px + header padding
 * 2 x 11.2px + one 6.4px gap + borders ≈ 3.4rem at 16px/rem, plus a little
 * slack so a title never lands one pixel short and ellipsizes. */
const SONG_NAME_CHROME_REM = 3.6;
/** BPM badge 55.3px + key badge 29.2px + their two 6.4px gaps ≈ 6.1rem. Both
 * badges are assumed present when either is: which ones show depends on the
 * region, and reserving for the pair keeps every column in a project aligned
 * on the same rule. */
const SONG_BADGES_REM = 6.1;

let measureCanvas: HTMLCanvasElement | null = null;

/** Width in px of `text` as the song-name label renders it. Returns null when
 * measurement isn't possible (SSR, jsdom without canvas), so callers fall
 * back to the fixed default rather than guessing. */
export function measureSongNameWidthPx(text: string): number | null {
  if (typeof document === "undefined") return null;
  try {
    measureCanvas ??= document.createElement("canvas");
    const context = measureCanvas.getContext("2d");
    if (!context) return null;
    context.font = SONG_NAME_FONT;
    // The label is uppercased by CSS (text-transform), so measure the same
    // glyphs the user actually sees — lowercase text measures narrower.
    const shown = text.toUpperCase();
    return (
      context.measureText(shown).width +
      shown.length * SONG_NAME_LETTER_SPACING_PX
    );
  } catch {
    return null;
  }
}

/** The reference title the baseline column width is derived from: the name a
 * freshly created song gets (see `default_region_name` in song_edit.rs).
 * Deliberately the ENGLISH form — "Song 1" is shorter than "Canción 1", so a
 * baseline built from it stays tight, and the auto-fit widens any real title
 * that needs more. Using the localized name instead would make the whole
 * strip wider for Spanish users for no benefit. */
const BASELINE_SONG_NAME = "Song 1";

/** Width, in rem, that a column needs to show `name` in full alongside the
 * play button and (optionally) the badges. Pure geometry — no clamping. */
function fittedWidthRem(name: string, hasBadges: boolean): number | null {
  const textPx = measureSongNameWidthPx(name);
  if (textPx == null) return null;
  const chromeRem = SONG_NAME_CHROME_REM + (hasBadges ? SONG_BADGES_REM : 0);
  return textPx / rootFontSizePx() + chromeRem;
}

/**
 * The narrowest a column goes by default: exactly enough for the baseline
 * title "Song 1" plus every badge. This is the floor the auto-fit never dips
 * below, so a strip of freshly-created songs is as tight as it can be while
 * still reading cleanly.
 *
 * Computed rather than hard-coded so it tracks the real font metrics; falls
 * back to the fixed default when text can't be measured (SSR / jsdom).
 */
export function baselineColumnWidthRem(): number {
  const fitted = fittedWidthRem(BASELINE_SONG_NAME, true);
  return fitted == null
    ? COMPACT_COLUMN_DEFAULT_WIDTH_REM
    : Math.min(COMPACT_COLUMN_MAX_WIDTH_REM, fitted);
}

/**
 * Default width for a column whose song is named `name`: wide enough to show
 * the whole title (plus the play button and badges), never narrower than the
 * "Song 1" baseline and never past the max.
 *
 * Only a DEFAULT — the moment the user drags a column, the persisted width
 * wins and this is not consulted again for that song.
 */
export function autoColumnWidthRem(
  name: string,
  options: { hasBadges?: boolean } = {},
): number {
  const baselineRem = baselineColumnWidthRem();
  const fitted = fittedWidthRem(name, options.hasBadges === true);
  if (fitted == null) return baselineRem;
  return Math.min(
    COMPACT_COLUMN_MAX_WIDTH_REM,
    Math.max(baselineRem, fitted),
  );
}

/** Width a column should render at: the user's persisted value, else the
 * auto-fit width for its title (falling back to the "Song 1" baseline when
 * no auto width was supplied). */
export function resolveColumnWidthRem(
  persistedWidthRem: number | null | undefined,
  autoWidthRem?: number,
): number {
  if (persistedWidthRem != null) return clampColumnWidthRem(persistedWidthRem);
  return autoWidthRem ?? baselineColumnWidthRem();
}

type UseColumnResizeOptions = {
  /** Persisted width for this column, or null to use the default. */
  persistedWidthRem: number | null | undefined;
  /** The song's name. With no persisted width the column sizes itself to show
   * this in full (never below COMPACT_COLUMN_DEFAULT_WIDTH_REM). */
  songName: string;
  /** Whether the header renders the BPM / key badges, which take room from the
   * title and so widen the auto-fit. */
  hasBadges: boolean;
  /** Commits the width to the project. Called ONCE on pointer-up, never
   * during the drag: every commit round-trips through the Tauri command and
   * rewrites the session, which at 60fps would hammer the backend and flood
   * undo history with a hundred intermediate widths. `null` restores the
   * default width (double-click on the handle). */
  onCommit: (widthRem: number | null) => void;
};

/**
 * Pointer-drag resize for one compact-view song column.
 *
 * The live width is local state so the column tracks the pointer at native
 * speed without waiting for a snapshot round-trip; the persisted value only
 * arrives back through props after the commit. Whenever the user is NOT
 * dragging, the prop wins — that way an undo, a reload, or a resize made in
 * another view is reflected immediately.
 */
export function useColumnResize({
  persistedWidthRem,
  songName,
  hasBadges,
  onCommit,
}: UseColumnResizeOptions) {
  const [isResizing, setIsResizing] = useState(false);
  const [draftWidthRem, setDraftWidthRem] = useState<number | null>(null);

  // Live drag bookkeeping. Refs, not state: these change on every pointermove
  // and nothing renders off them directly.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidthRem: number;
    pxPerRem: number;
    latestWidthRem: number;
  } | null>(null);

  // Keep the newest onCommit without restarting the drag listeners: the
  // parent passes a fresh closure on most renders, and re-subscribing
  // mid-drag would drop the in-flight pointer capture.
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  // Web fonts load asynchronously, and a canvas measurement taken before
  // "Space Grotesk" is ready silently uses the fallback face — which is wider,
  // so every column would sit a few px off until something else re-rendered
  // it. Bump a counter once the fonts settle to re-measure.
  const [fontsRevision, setFontsRevision] = useState(0);
  useEffect(() => {
    const fonts = typeof document === "undefined" ? null : document.fonts;
    if (!fonts || fonts.status === "loaded") return;
    let cancelled = false;
    fonts.ready
      .then(() => {
        if (!cancelled) setFontsRevision((value) => value + 1);
      })
      .catch(() => {
        // Font loading failed; the fallback measurement is what we get.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Measuring text hits a canvas, so memoize on the inputs that change it.
  const autoWidthRem = useMemo(
    () => autoColumnWidthRem(songName, { hasBadges }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontsRevision is
    // a re-measure trigger, not a value the calculation reads.
    [songName, hasBadges, fontsRevision],
  );

  const widthRem =
    isResizing && draftWidthRem !== null
      ? draftWidthRem
      : resolveColumnWidthRem(persistedWidthRem, autoWidthRem);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Left button only; ignore right-click and middle-click so the column's
      // context menu still opens normally.
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      // Start from what is on screen (auto-fit included), so grabbing the
      // handle never makes the column jump before the pointer has moved.
      const startWidthRem = resolveColumnWidthRem(
        persistedWidthRem,
        autoWidthRem,
      );
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidthRem,
        pxPerRem: rootFontSizePx(),
        latestWidthRem: startWidthRem,
      };
      setDraftWidthRem(startWidthRem);
      setIsResizing(true);
    },
    [persistedWidthRem, autoWidthRem],
  );

  // Window-level listeners so the drag survives the pointer leaving the
  // handle — the same approach the track-header and fader drags use.
  useEffect(() => {
    if (!isResizing) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaRem = (event.clientX - drag.startX) / drag.pxPerRem;
      const next = clampColumnWidthRem(drag.startWidthRem + deltaRem);
      drag.latestWidthRem = next;
      setDraftWidthRem(next);
    };

    const finish = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const committed = drag.latestWidthRem;
      dragRef.current = null;
      setIsResizing(false);
      setDraftWidthRem(null);
      // Only write when the width actually moved, so a stray click on the
      // handle doesn't push a no-op edit onto the undo stack.
      if (Math.abs(committed - drag.startWidthRem) > 0.01) {
        onCommitRef.current(committed);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Abort: drop the draft and keep the persisted width.
      dragRef.current = null;
      setIsResizing(false);
      setDraftWidthRem(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isResizing]);

  /** Keyboard resize for the handle: arrows nudge, Shift+arrows jump. Keeps
   * the affordance reachable without a pointer. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 4 : 1;
      let delta = 0;
      if (event.key === "ArrowLeft") delta = -step;
      else if (event.key === "ArrowRight") delta = step;
      else return;
      event.preventDefault();
      const current = resolveColumnWidthRem(persistedWidthRem, autoWidthRem);
      const next = clampColumnWidthRem(current + delta);
      if (next !== current) {
        onCommitRef.current(next);
      }
    },
    [persistedWidthRem, autoWidthRem],
  );

  /** Double-click the handle → back to the default width, like resetting a
   * fader to unity. Commits `null` so the column follows the default again
   * rather than pinning the current default as an explicit value. */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onCommitRef.current(null);
    },
    [],
  );

  return {
    widthRem,
    isResizing,
    handlePointerDown,
    handleKeyDown,
    handleDoubleClick,
  };
}
