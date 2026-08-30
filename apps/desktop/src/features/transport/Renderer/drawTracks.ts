import type { SongView, WaveformSummaryDto } from "../desktopApi";
import { getPendingClipLabel, type TimelineClipSummary, type TimelineTrackSummary } from "../library/pendingAudioImports";
import { clipDisplayName } from "../helpers";
// The canvas renderer is not a React component, so it reads from the i18n
// singleton directly (whose .t always reflects the current language) rather
// than threading `t` through every snapshot construction site.
import i18n from "../../../shared/i18n";
import { recordTileDrain, reportWaveformTileCache } from "../perf/perfMetrics";
import type { TrackSceneSnapshot, TimelineViewportMetrics } from "./TimelineRenderer";
import { clamp, secondsToScreenX } from "../timeline/timelineMath";
import type { TrackRowLayout } from "../tracks/trackLayout";
import {
  drawWaveformSketch,
  getWaveformRenderPixelsPerSecond,
  WaveformTileCache,
  WAVEFORM_TILE_FRAME_BUDGET_MS,
  WAVEFORM_TILE_WIDTH_PX,
} from "./WaveformTileCache";

const waveformTileCache = new WaveformTileCache();

/** Read-only cache gauge for native crash breadcrumbs. Unlike the PerfHud
 * metric, this remains available when performance recording is switched off. */
export function getWaveformTileCacheDiagnostics() {
  return waveformTileCache.stats();
}

/** iOS memory warnings evict scroll history, but never tiles that belong to
 * the currently painted viewport. */
export function releaseNonVisibleWaveformTiles() {
  const before = waveformTileCache.stats();
  waveformTileCache.releaseNonVisible();
  return { before, after: waveformTileCache.stats() };
}

/**
 * Índices derivados del `song`, calculados una vez por identidad de canción en
 * vez de una vez por carril y por frame.
 *
 * Antes, el bucle de dibujo hacía por FRAME: un `tracks.filter()` por cada
 * carril de carpeta visible, un `[...cues].sort()` en la pista de automatización
 * y un `.filter().sort()` por cada pista MIDI. A 144 fps con 29 pistas eso es
 * ruido de asignación puro, y el `song` no cambia entre frames.
 *
 * El `WeakMap` se apoya en la identidad del `song`: cambia sólo cuando el
 * backend publica una revisión nueva, que es exactamente cuando estos índices
 * dejan de ser válidos. Y al ser débil no retiene canciones cerradas.
 *
 * **Condición que hay que respetar:** el `song` se REEMPLAZA entero, nunca se
 * muta en sitio. Todo el frontend lo cumple hoy (`setSong` siempre recibe un
 * objeto nuevo, incluidos los parches optimistas de color y de pista). Si algún
 * día alguien mutara `song.automationCues` o `song.tracks` sin cambiar la
 * identidad del objeto, este índice se quedaría obsoleto y el carril dibujaría
 * datos viejos.
 */
type SongDrawIndex = {
  childCountByTrackId: Map<string, number>;
  /** Cues ordenadas por tiempo: `drawAutomationLane` las lee en ese orden. */
  sortedAutomationCues: NonNullable<SongView["automationCues"]>;
  /** Clips MIDI agrupados por pista y ordenados por posición. */
  midiClipsByTrackId: Map<string, NonNullable<SongView["midiClips"]>>;
};

const songDrawIndexCache = new WeakMap<SongView, SongDrawIndex>();

function getSongDrawIndex(song: SongView): SongDrawIndex {
  const cached = songDrawIndexCache.get(song);
  if (cached) {
    return cached;
  }

  const childCountByTrackId = new Map<string, number>();
  for (const track of song.tracks) {
    if (!track.parentTrackId) continue;
    childCountByTrackId.set(
      track.parentTrackId,
      (childCountByTrackId.get(track.parentTrackId) ?? 0) + 1,
    );
  }

  const sortedAutomationCues = [...(song.automationCues ?? [])].sort(
    (left, right) => left.atSeconds - right.atSeconds,
  );

  const midiClipsByTrackId = new Map<
    string,
    NonNullable<SongView["midiClips"]>
  >();
  for (const clip of song.midiClips ?? []) {
    const bucket = midiClipsByTrackId.get(clip.trackId);
    if (bucket) {
      bucket.push(clip);
    } else {
      midiClipsByTrackId.set(clip.trackId, [clip]);
    }
  }
  for (const clips of midiClipsByTrackId.values()) {
    clips.sort(
      (left, right) => left.timelineStartSeconds - right.timelineStartSeconds,
    );
  }

  const index: SongDrawIndex = {
    childCountByTrackId,
    sortedAutomationCues,
    midiClipsByTrackId,
  };
  songDrawIndexCache.set(song, index);
  return index;
}

/** The flat colour the track area is painted with, and the backdrop that
 * anything wanting to mask the grid must blend against. */
const TRACK_BACKDROP_RGB = [14, 14, 14] as const;
const TRACK_BACKDROP = `rgb(${TRACK_BACKDROP_RGB[0]}, ${TRACK_BACKDROP_RGB[1]}, ${TRACK_BACKDROP_RGB[2]})`;

/** How much of its own colour the folder band keeps. The band is the track
 * colour darkened towards black — NOT mixed with grey. Mixing a hue with grey
 * washes out its saturation (a red folder came out pink), whereas scaling the
 * channels keeps the hue and only drops the brightness, which is what makes the
 * row read as the same red as the track below it. */
const FOLDER_BAND_DARKEN = 0.62;

/** Type scale for the folder lane caption, keyed to the row's height.
 *
 * Track rows span 18..148px (TRACK_HEIGHT_MIN/MAX), an 8x range, so a fixed
 * font that reads well in a thin lane is lost in a tall one. The name grows
 * with the row; the count grows more slowly so it stays subordinate as the gap
 * widens.
 *
 * The floor is the size the caption used before it scaled at all: the smallest
 * row must stay as readable as it is today, so the scale only ever adds size.
 * The interpolation runs over the row heights where text has room to breathe —
 * below `HEIGHT_AT_MIN` the lane is too thin for the glyphs to grow into
 * anyway, and above `HEIGHT_AT_MAX` a caption that kept growing would start
 * competing with the clips rather than labelling the row. */
const FOLDER_CAPTION_TYPE = {
  HEIGHT_AT_MIN: 40,
  HEIGHT_AT_MAX: 132,
  NAME_MIN_PX: 11,
  NAME_MAX_PX: 19,
  COUNT_MIN_PX: 10,
  COUNT_MAX_PX: 13,
} as const;

/** Interpolate the caption's name/count font sizes for a row `trackHeight`.
 * Sizes are rounded to whole pixels: canvas will happily render a 13.4px font,
 * but fractional sizes make the caption shimmer as the row is dragged. */
export function folderCaptionFontSizes(trackHeight: number): {
  namePx: number;
  countPx: number;
} {
  const { HEIGHT_AT_MIN, HEIGHT_AT_MAX } = FOLDER_CAPTION_TYPE;
  const span = HEIGHT_AT_MAX - HEIGHT_AT_MIN;
  const t = clamp((trackHeight - HEIGHT_AT_MIN) / span, 0, 1);
  const lerp = (min: number, max: number) => Math.round(min + (max - min) * t);
  return {
    namePx: lerp(FOLDER_CAPTION_TYPE.NAME_MIN_PX, FOLDER_CAPTION_TYPE.NAME_MAX_PX),
    countPx: lerp(FOLDER_CAPTION_TYPE.COUNT_MIN_PX, FOLDER_CAPTION_TYPE.COUNT_MAX_PX),
  };
}

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into RGB channels; null if unparsable. */
function parseHexRgb(hex: string): [number, number, number] | null {
  const value = hex.replace("#", "");
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  if (expanded.length < 6) {
    return null;
  }
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
    ? [r, g, b]
    : null;
}

/** Blend `hex` onto the track backdrop at `alpha` and return an OPAQUE colour.
 * Chips drawn over the timeline sit on top of a full-strength grid; a
 * translucent body lets those lines read through the text, so they pre-blend. */
function blendOnTrackBackdrop(hex: string, alpha: number): string {
  const top = parseHexRgb(hex);
  if (!top) {
    return TRACK_BACKDROP;
  }
  const mix = (channel: number, under: number) =>
    Math.round(channel * alpha + under * (1 - alpha));
  return `rgb(${mix(top[0], TRACK_BACKDROP_RGB[0])}, ${mix(top[1], TRACK_BACKDROP_RGB[1])}, ${mix(top[2], TRACK_BACKDROP_RGB[2])})`;
}

/** Scale `hex` towards black by `factor`, returning an OPAQUE colour. Unlike
 * blending with a grey, this preserves the hue's saturation — only the
 * brightness drops — so the result still reads as the original colour. */
function darken(hex: string, factor: number): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) {
    return TRACK_BACKDROP;
  }
  const scale = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel * factor)));
  return `rgb(${scale(rgb[0])}, ${scale(rgb[1])}, ${scale(rgb[2])})`;
}

export function drawTrackCanvasBackground(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
) {
  context.fillStyle = TRACK_BACKDROP;
  context.fillRect(0, 0, snapshot.width, snapshot.height);
}

/** Re-state the bar lines faintly across an opaque folder band, so the row does
 * not read as a flat slab cutting the timeline in two. Bars only (never the
 * denser beat lines) and at a low alpha, so the caption stays legible — the
 * band exists precisely to stop the full-strength grid crossing the text. */
function drawFolderBandGridHint(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  trackTop: number,
  rowHeight: number,
) {
  const bars = snapshot.timelineGrid?.bars;
  if (!bars || bars.length === 0) {
    return;
  }

  context.save();
  context.strokeStyle = "rgba(255, 255, 255, 0.07)";
  context.lineWidth = 1;
  context.beginPath();
  for (const seconds of bars) {
    const x =
      Math.round(secondsToScreenX(seconds, snapshot.cameraX, snapshot.zoomLevel)) +
      0.5;
    if (x < 0 || x > snapshot.width) {
      continue;
    }
    context.moveTo(x, trackTop);
    context.lineTo(x, trackTop + rowHeight);
  }
  context.stroke();
  context.restore();
}

function clipScreenBounds(
  clip: TimelineClipSummary,
  startSeconds: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  return {
    left: secondsToScreenX(startSeconds, cameraX, pixelsPerSecond),
    width: clip.durationSeconds * pixelsPerSecond,
  };
}

/** Narrower than this and the label is noise rather than information — the
 * shaded band already says "not analysed yet". */
const PLACEHOLDER_LABEL_MIN_WIDTH_PX = 96;

/** The placeholder's own caption, in the user's language.
 *
 * This used to be a hardcoded English default while every other pending label
 * went through i18n, so a Spanish session read "ANALYZING WAVEFORM..." on the
 * one clip state the user sees most. Resolved per call (not hoisted to a
 * constant) so it follows a language change without a reload, like the rest of
 * the canvas text. */
function analyzingWaveformLabel() {
  return getPendingClipLabel("analyzing", (key) => i18n.t(key));
}

function drawWaveformPlaceholder(
  context: CanvasRenderingContext2D,
  left: number,
  width: number,
  top: number,
  height: number,
  label = analyzingWaveformLabel(),
  showLabel = true,
) {
  context.save();
  context.beginPath();
  context.roundRect(left, top, width, height, 2);
  context.clip();

  // Solid background
  context.fillStyle = "rgba(229, 226, 225, 0.12)";
  context.fillRect(left, top, width, height);

  if (showLabel && width >= PLACEHOLDER_LABEL_MIN_WIDTH_PX) {
    context.fillStyle = "rgba(20, 20, 20, 0.85)";
    context.font = '700 11px "Space Grotesk", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.toUpperCase(), left + width / 2, top + height / 2);
  }

  context.restore();
}

/**
 * How much of a clip already has real peaks, as a 0..1 fraction of its drawn
 * width, for a summary that is still being analysed.
 *
 * Two conversions matter here:
 *  - `analyzedSeconds` counts from the start of the SOURCE file, while a clip
 *    may start anywhere inside it. A clip whose window begins past the analysed
 *    point has nothing to draw yet even though the summary is non-empty.
 *  - The result is a fraction of the clip, not a duration. A warped clip is
 *    drawn over its TIMELINE length while the peaks are indexed by SOURCE time,
 *    so multiplying seconds by the zoom would put the boundary in the wrong
 *    place for exactly the clips whose two clocks differ.
 *
 * Returns null when the summary is complete — nothing to mark as pending.
 */
export function analyzedClipRatio(
  clip: TimelineClipSummary,
  waveform: WaveformSummaryDto | undefined,
): number | null {
  const analyzedSeconds = waveform?.analyzedSeconds;
  if (analyzedSeconds === undefined) {
    return null;
  }
  const visibleSourceSeconds =
    clip.sourceWindowDurationSeconds ?? clip.durationSeconds;
  if (!(visibleSourceSeconds > 0)) {
    return 0;
  }
  return clamp(
    (analyzedSeconds - clip.sourceStartSeconds) / visibleSourceSeconds,
    0,
    1,
  );
}

function resolveVisibleTrackWindow(
  layout: TrackRowLayout,
  viewportScrollTop: number,
  viewportHeight: number,
) {
  const trackCount = layout.heights.length;
  const safeScrollTop = Math.max(0, viewportScrollTop);
  const safeViewportHeight = Math.max(
    layout.baseHeight,
    viewportHeight || layout.baseHeight,
  );
  // One row of slack on each side, so a row scrolling into view is already
  // painted. Rows have their own heights now, hence rowAt() rather than a
  // division by a shared height.
  const startIndex = clamp(layout.rowAt(safeScrollTop) - 1, 0, trackCount);
  const endIndex = clamp(
    layout.rowAt(safeScrollTop + safeViewportHeight) + 2,
    startIndex,
    trackCount,
  );

  return { startIndex, endIndex };
}

/**
 * Paint the automation cues as diamonds along the synthetic automation track's
 * row. Mirrors the old ruler-lane look (drawRulerAutomationCue) but anchored to
 * the track's `top`/`trackHeight` instead of a fixed header lane.
 */
/** Truncate `text` with an ellipsis so it fits within `maxTextWidth` px. Returns
 * null when not even a single char + ellipsis fits (caller then hides the label,
 * Ableton-style: the diamond stays, the text drops). */
function fitLabel(
  context: CanvasRenderingContext2D,
  text: string,
  maxTextWidth: number,
): string | null {
  if (context.measureText(text).width <= maxTextWidth) {
    return text;
  }
  const ellipsis = "…";
  if (context.measureText(ellipsis).width > maxTextWidth) {
    return null;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (context.measureText(text.slice(0, mid) + ellipsis).width <= maxTextWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : null;
}

export function drawAutomationLane(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  trackTop: number,
  rowHeight: number = snapshot.trackHeight,
) {
  const laneHeight = rowHeight;
  const centerY = trackTop + laneHeight / 2;

  // Ableton-style collision handling: a cue's label may only extend up to the
  // next cue's diamond, so el orden por tiempo es parte del dibujo. Viene ya
  // ordenado del índice por canción (antes se ordenaba en cada frame).
  const cues = getSongDrawIndex(snapshot.song).sortedAutomationCues;

  const LABEL_PADDING_X = 8;
  const LABEL_GAP = 10; // min px between this label's end and the next diamond
  const DIAMOND_HALF = 6;

  context.font = '700 10px "Space Grotesk", sans-serif';

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const x = secondsToScreenX(cue.atSeconds, snapshot.cameraX, snapshot.zoomLevel);
    const snappedX = Math.round(x) + 0.5;

    // The diamond always draws (the anchor never disappears). Cull only when the
    // diamond itself is well off-screen.
    if (snappedX < -DIAMOND_HALF - 2 || snappedX > snapshot.width + DIAMOND_HALF + 2) {
      continue;
    }

    const strokeStyle = cue.enabled
      ? "rgba(255, 122, 182, 0.95)"
      : "rgba(186, 202, 197, 0.45)";
    // Opaque fills: the diamond and the label pill sit over the full-strength
    // timeline grid, and a translucent body let those lines read straight
    // through the cue text.
    const fillStyle = cue.enabled
      ? blendOnTrackBackdrop("#ff7ab6", 0.22)
      : blendOnTrackBackdrop("#bacac5", 0.12);
    const textStyle = cue.enabled ? "#ffb3d8" : "rgba(186, 202, 197, 0.75)";

    context.save();
    context.strokeStyle = strokeStyle;
    context.fillStyle = fillStyle;
    context.lineWidth = 1.2;

    // Full-height stem.
    context.beginPath();
    context.moveTo(snappedX, trackTop + 3);
    context.lineTo(snappedX, trackTop + laneHeight - 3);
    context.stroke();

    // Diamond marker.
    context.beginPath();
    context.moveTo(snappedX, centerY - 6);
    context.lineTo(snappedX + 6, centerY);
    context.lineTo(snappedX, centerY + 6);
    context.lineTo(snappedX - 6, centerY);
    context.closePath();
    context.fill();
    context.stroke();

    // Label summarizes the job: the cue name plus a count when it has more than
    // a single action (e.g. "Salto a Coro  ·  +2"). Truncated to the room before
    // the next cue's diamond; if nothing fits, only the diamond remains.
    const actions = cue.actions ?? [];
    const extraCount = Math.max(0, actions.length - 1);
    const countSuffix = extraCount > 0 ? `  ·  +${extraCount}` : "";
    const baseLabel = `→ ${cue.name.replace(/^Salto a\s+/i, "")}`;
    const fullLabel = cue.enabled
      ? `${baseLabel}${countSuffix}`
      : `${baseLabel}${countSuffix} (off)`;

    const labelStart = snappedX + DIAMOND_HALF + 2;
    // Right boundary = next cue's diamond (minus a gap), or the canvas edge.
    const nextCue = cues[index + 1];
    const nextX = nextCue
      ? secondsToScreenX(nextCue.atSeconds, snapshot.cameraX, snapshot.zoomLevel)
      : Number.POSITIVE_INFINITY;
    const rightBoundary = Math.min(
      snapshot.width - 4,
      Number.isFinite(nextX) ? nextX - DIAMOND_HALF - LABEL_GAP : snapshot.width - 4,
    );
    const availableTextWidth = rightBoundary - labelStart - LABEL_PADDING_X * 2;

    const fitted =
      availableTextWidth > 8
        ? fitLabel(context, fullLabel, availableTextWidth)
        : null;

    if (fitted) {
      const textWidth = context.measureText(fitted).width;
      const pillWidth = textWidth + LABEL_PADDING_X * 2;
      context.beginPath();
      context.roundRect(labelStart, centerY - 7.5, pillWidth, 15, 4);
      context.fill();
      context.stroke();
      context.fillStyle = textStyle;
      context.textBaseline = "middle";
      context.fillText(fitted, labelStart + LABEL_PADDING_X, centerY + 0.5);
    }
    context.restore();
  }
}

/**
 * Paint a MIDI track's clips.
 *
 * A MIDI clip is a bundle of messages fired at one point, not a block of
 * audio, so it reads as a marker with a label rather than a waveform. Clips
 * whose events span time (a held note, a controller sweep) get a trailing bar
 * showing that extent, which is what makes a long fade legible on the timeline.
 */
export function drawMidiLane(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  trackTop: number,
  trackId: string,
  rowHeight: number = snapshot.trackHeight,
) {
  const laneHeight = rowHeight;
  const centerY = trackTop + laneHeight / 2;

  const clips =
    getSongDrawIndex(snapshot.song).midiClipsByTrackId.get(trackId) ?? [];
  if (clips.length === 0) {
    return;
  }

  const LABEL_PADDING_X = 8;
  const LABEL_GAP = 10;
  const MARKER_HALF = 5;
  // Same violet the MIDI track header uses, so the lane reads as belonging to
  // it rather than to the (pink) automation lane.
  const ACCENT = "#9d7bff";

  context.font = '700 10px "Space Grotesk", sans-serif';

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const x = secondsToScreenX(
      clip.timelineStartSeconds,
      snapshot.cameraX,
      snapshot.zoomLevel,
    );
    const snappedX = Math.round(x) + 0.5;

    // How far the clip's contents run: the longest (offset + duration) of its
    // events. Instantaneous bundles report 0 and draw as a bare marker.
    let extentSeconds = 0;
    for (const event of clip.events ?? []) {
      const eventDuration =
        event.kind.type === "note" || event.kind.type === "controlCurve"
          ? Math.max(0, event.kind.durationSeconds)
          : 0;
      extentSeconds = Math.max(
        extentSeconds,
        Math.max(0, event.atSeconds) + eventDuration,
      );
    }
    const endX = secondsToScreenX(
      clip.timelineStartSeconds + extentSeconds,
      snapshot.cameraX,
      snapshot.zoomLevel,
    );

    if (
      endX < -MARKER_HALF - 2 ||
      snappedX > snapshot.width + MARKER_HALF + 2
    ) {
      continue;
    }

    const strokeStyle = clip.color ?? ACCENT;
    const fillStyle = blendOnTrackBackdrop(clip.color ?? ACCENT, 0.22);

    context.save();
    context.strokeStyle = strokeStyle;
    context.fillStyle = fillStyle;
    context.lineWidth = 1.2;

    // Extent bar first, so the marker draws over its left edge.
    if (endX - snappedX > 1) {
      context.beginPath();
      context.roundRect(snappedX, centerY - 3.5, endX - snappedX, 7, 3);
      context.fill();
      context.stroke();
    }

    // Full-height stem + marker, mirroring the automation lane's anchor.
    context.beginPath();
    context.moveTo(snappedX, trackTop + 3);
    context.lineTo(snappedX, trackTop + laneHeight - 3);
    context.stroke();

    context.beginPath();
    context.moveTo(snappedX, centerY - MARKER_HALF);
    context.lineTo(snappedX + MARKER_HALF, centerY);
    context.lineTo(snappedX, centerY + MARKER_HALF);
    context.lineTo(snappedX - MARKER_HALF, centerY);
    context.closePath();
    context.fill();
    context.stroke();

    const eventCount = (clip.events ?? []).length;
    const countSuffix = eventCount > 1 ? `  ·  ${eventCount}` : "";
    const fullLabel = `${clip.name || "MIDI"}${countSuffix}`;

    const labelStart = Math.max(snappedX, endX) + MARKER_HALF + 2;
    const nextClip = clips[index + 1];
    const nextX = nextClip
      ? secondsToScreenX(
          nextClip.timelineStartSeconds,
          snapshot.cameraX,
          snapshot.zoomLevel,
        )
      : Number.POSITIVE_INFINITY;
    const rightBoundary = Math.min(
      snapshot.width - 4,
      Number.isFinite(nextX) ? nextX - MARKER_HALF - LABEL_GAP : snapshot.width - 4,
    );
    const availableTextWidth = rightBoundary - labelStart - LABEL_PADDING_X * 2;

    const fitted =
      availableTextWidth > 8 ? fitLabel(context, fullLabel, availableTextWidth) : null;

    if (fitted) {
      const textWidth = context.measureText(fitted).width;
      const pillWidth = textWidth + LABEL_PADDING_X * 2;
      context.beginPath();
      context.roundRect(labelStart, centerY - 7.5, pillWidth, 15, 4);
      context.fill();
      context.stroke();
      context.fillStyle = clip.color ?? "#c4b0ff";
      context.textBaseline = "middle";
      context.fillText(fitted, labelStart + LABEL_PADDING_X, centerY + 0.5);
    }
    context.restore();
  }
}

export function drawTrackClipsLayer(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  viewport: TimelineViewportMetrics,
) {
  const layout = snapshot.trackLayout;
  const { startIndex: visibleTrackStart, endIndex: visibleTrackEnd } =
    resolveVisibleTrackWindow(layout, viewport.scrollTop, viewport.height);

  beginWaveformTilePaint();
  const songDrawIndex = getSongDrawIndex(snapshot.song);
  // `includes` por clip es O(seleccionados) dentro del bucle; el Set se
  // construye una vez por pintado.
  const selectedClipIdSet = new Set(snapshot.selectedClipIds);

  context.save();
  context.clearRect(0, 0, snapshot.width, snapshot.height);

  // Vertical clip-drag preview: a clip can be temporarily painted on a lane
  // other than its own bucket. Resolve destination lane indices up front so the
  // per-clip loop can shift `clipTop` to the target row.
  const previewTrackIdByClip = snapshot.clipPreviewTrackIdRef.current;
  const trackIndexById = new Map<string, number>();
  for (let i = 0; i < snapshot.visibleTracks.length; i += 1) {
    trackIndexById.set(snapshot.visibleTracks[i].id, i);
  }

  for (let trackIndex = visibleTrackStart; trackIndex < visibleTrackEnd; trackIndex += 1) {
    const track = snapshot.visibleTracks[trackIndex];
    const trackTop = layout.tops[trackIndex];
    const rowHeight = layout.heights[trackIndex];
    const childCount = songDrawIndex.childCountByTrackId.get(track.id) ?? 0;

    if (track.isAutomation) {
      drawAutomationLane(context, snapshot, trackTop, rowHeight);
      continue;
    }

    if (track.kind === "midi") {
      drawMidiLane(context, snapshot, trackTop, track.id, rowHeight);
      continue;
    }

    if (track.kind === "folder") {
      // Full-bleed, like every other lane. The row used to be inset by 8px on
      // each side, which read as the folder not reaching the timeline edges.
      //
      // The band is opaque so the grid cannot run through it, but stays a tint
      // rather than a solid slab: a folder is a container, not content, and
      // should not compete with the clips below it.
      //
      // The band is the folder's own colour darkened, not that colour mixed
      // into the backdrop. Mixing towards near black turns a saturated red into
      // brown, and mixing towards grey turns it pink; both stopped the row
      // looking like the same colour as the track. Scaling the channels keeps
      // the hue and only drops the brightness.
      context.fillStyle = track.color
        ? darken(track.color, FOLDER_BAND_DARKEN)
        : blendOnTrackBackdrop("#201f1f", 0.5);
      context.fillRect(0, trackTop, snapshot.width, rowHeight);

      // Faint bar lines back on top. The band masks the full-strength grid
      // underneath (that is what made the caption hard to read), then this
      // re-states it at a fraction of the strength: the row keeps a sense of
      // the timeline running through it instead of looking like a flat slab.
      drawFolderBandGridHint(context, snapshot, trackTop, rowHeight);

      // Solid accent ribbon on the left edge, mirroring the track header's
      // border/ribbon. A tint alone never reads as the picked colour — the
      // header looks like its swatch because it also shows the colour
      // undiluted somewhere, and the row needs the same anchor to match.
      if (track.color) {
        context.fillStyle = track.color;
        context.fillRect(0, trackTop, 3, rowHeight);
      }

      // The folder's own name leads the caption. The row has width to spare,
      // and the header's name column is easy to lose track of once the timeline
      // is scrolled: naming the row where the content is keeps a collapsed
      // folder identifiable without looking back at the header. The child count
      // follows as a quieter suffix so the old information is still there,
      // subordinate to the name rather than replacing it.
      const labelCenterY = trackTop + rowHeight / 2;
      const countLabel = childCount
        ? i18n.t("trackHeader.laneFolderChildCount", { count: childCount })
        : i18n.t("trackHeader.laneFolderEmpty");
      const folderName = track.name?.trim() ?? "";

      // No chip behind the caption: the band already masks the grid, so the
      // text only needs to out-contrast the band itself. The band now carries
      // the folder's colour, so the caption is near white — tinting it with the
      // colour too left it barely readable against its own background.
      const nameColor = track.color ? "rgba(255, 255, 255, 0.92)" : "#bacac5";
      const countColor = track.color ? "rgba(255, 255, 255, 0.62)" : "#8a9a95";

      // Budget the caption against the lane, not the canvas: at low zoom the
      // name would otherwise run the full width and read as a clip.
      const labelStartX = 13;
      const captionMaxWidth = Math.max(0, snapshot.width - labelStartX - 12);
      // The gap tracks the type size so the two words keep their spacing
      // relationship instead of colliding as the caption grows.
      const { namePx, countPx } = folderCaptionFontSizes(rowHeight);
      const nameFont = `600 ${namePx}px "Space Grotesk", sans-serif`;
      const countFont = `500 ${countPx}px "Space Grotesk", sans-serif`;
      const countGap = Math.round(countPx * 0.8);

      context.textBaseline = "middle";
      if (folderName) {
        // The name is heavier and a step larger than the count so the two read
        // as label and annotation rather than one run-on string.
        context.font = nameFont;
        const countWidth = (() => {
          context.save();
          context.font = countFont;
          const width = context.measureText(countLabel).width;
          context.restore();
          return width;
        })();

        // Give the name the room it needs, but never let it squeeze the count
        // out entirely — reserve the count's width up front, and only let the
        // name spill into it when the name alone cannot fit the lane.
        const nameBudget = Math.max(
          captionMaxWidth * 0.5,
          captionMaxWidth - countWidth - countGap,
        );
        const fittedName = fitLabel(context, folderName, nameBudget);
        if (fittedName) {
          context.fillStyle = nameColor;
          context.fillText(fittedName, labelStartX, labelCenterY);

          const nameWidth = context.measureText(fittedName).width;
          const countX = labelStartX + nameWidth + countGap;
          const countBudget = captionMaxWidth - (countX - labelStartX);
          if (countBudget > 0) {
            context.font = countFont;
            const fittedCount = fitLabel(context, countLabel, countBudget);
            if (fittedCount) {
              context.fillStyle = countColor;
              context.fillText(fittedCount, countX, labelCenterY);
            }
          }
          continue;
        }
      }

      // Unnamed folder, or a lane too narrow for the name: fall back to the
      // count on its own, which is what the row showed before. It carries the
      // caption alone here, so it takes the name's size rather than the
      // deliberately-subordinate count size.
      context.font = nameFont;
      const fittedCountOnly = fitLabel(context, countLabel, captionMaxWidth);
      if (fittedCountOnly) {
        context.fillStyle = nameColor;
        context.fillText(fittedCountOnly, labelStartX, labelCenterY);
      }
      continue;
    }

    const trackClips = snapshot.clipsByTrack[track.id] ?? [];
    for (const clip of trackClips) {
      const previewStartSeconds = snapshot.clipPreviewSecondsRef.current[clip.id] ?? clip.timelineStartSeconds;
      const { left, width } = clipScreenBounds(
        clip,
        previewStartSeconds,
        snapshot.cameraX,
        snapshot.zoomLevel,
      );
      const right = left + width;

      if (right < 0 || left > snapshot.width || width <= 1) {
        continue;
      }

      const clippedLeft = clamp(left, 0, snapshot.width);
      const clippedRight = clamp(right, 0, snapshot.width);
      const visibleWidth = Math.max(2, clippedRight - clippedLeft);
      // While dragging vertically, paint the clip on its destination lane.
      const previewTrackId = previewTrackIdByClip[clip.id];
      const previewTrackIndex =
        previewTrackId !== undefined ? trackIndexById.get(previewTrackId) : undefined;
      const clipTop =
        previewTrackIndex !== undefined ? layout.tops[previewTrackIndex] : trackTop;
      // A ghost on another lane takes THAT lane's height, so the preview shows
      // the clip as it will land rather than as it currently sits.
      const clipHeight =
        previewTrackIndex !== undefined ? layout.heights[previewTrackIndex] : rowHeight;
      const isSelected =
        snapshot.selectedClipId === clip.id || selectedClipIdSet.has(clip.id);

      context.fillStyle = clip.color ?? track.color ?? "rgba(210, 212, 209, 0.92)";
      context.strokeStyle =
        isSelected ? "rgba(87, 241, 219, 0.9)" : "rgba(12, 12, 12, 0.28)";
      context.lineWidth = isSelected ? 1.5 : 1;
      context.beginPath();
      context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
      context.fill();
      context.stroke();

      const pendingLabel =
        clip.isPending ||
        clip.waveformStatus === "pending" ||
        clip.waveformStatus === "analyzing" ||
        clip.waveformStatus === "failed"
          ? getPendingClipLabel(
              clip.pendingStatus ?? (clip.waveformStatus === "failed" ? "failed" : "analyzing"),
              (key) => i18n.t(key),
            )
          : null;
      const waveform = snapshot.waveformCache[clip.waveformKey];
      // Fraction of the clip that already has real peaks; null once the summary
      // is complete. Non-null means the file is still being analysed and this
      // clip takes the progressive path below instead of the tile cache.
      const analyzedRatio = analyzedClipRatio(clip, waveform);
      // A partial summary (one still being analysed) is drawn like any other:
      // the peaks it has are real, and the stretch past `analyzedSeconds` gets
      // the placeholder band below. Showing the full-clip "ANALYZING" label on
      // top of a waveform that already exists is what made a slow analysis read
      // as a freeze — the work was visibly progressing and the UI hid it.
      if (pendingLabel && !waveform) {
        drawWaveformPlaceholder(context, clippedLeft, visibleWidth, clipTop, clipHeight, pendingLabel);
      } else if (waveform && analyzedRatio !== null) {
        // A file still being analysed: draw it DIRECTLY, never through the tile
        // cache.
        //
        // The peaks change every few dozen milliseconds while the analysis
        // runs, and a tile is only worth rasterising if it will be reused.
        // Feeding partials to the cache invalidated every tile of the clip on
        // each update, far faster than the frame budget could re-rasterise
        // them, so what actually got painted was the 64-column fallback sketch
        // — flickering between that and the real tiles, with the shape
        // changing each time. It is the same artefact as scrubbing the zoom
        // quickly, and for the same reason.
        //
        // Drawing straight to the canvas at ~one column per pixel is both
        // steadier and sharper here, and costs nothing to throw away: only the
        // clips under analysis right now (one per worker) take this path.
        context.save();
        context.beginPath();
        context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
        context.clip();
        if (analyzedRatio > 0) {
          const analysedWidth = width * analyzedRatio;
          drawWaveformSketch(context, clip, waveform, {
            fromRatio: 0,
            toRatio: analyzedRatio,
            left,
            width: analysedWidth,
            top: clipTop,
            height: clipHeight,
            maxBuckets: Math.ceil(analysedWidth),
          });
        }
        context.restore();

        // Shade the stretch that has not been read yet. No caption: the
        // waveform visibly growing already says the rest is on its way.
        const pendingLeft = left + analyzedRatio * width;
        const clippedPendingLeft = clamp(pendingLeft, clippedLeft, clippedRight);
        const pendingWidth = clippedRight - clippedPendingLeft;
        if (pendingWidth > 0.5) {
          drawWaveformPlaceholder(
            context,
            clippedPendingLeft,
            pendingWidth,
            clipTop,
            clipHeight,
            pendingLabel ?? analyzingWaveformLabel(),
            /*showLabel=*/ false,
          );
        }
      } else if (waveform) {
        context.save();
        context.beginPath();
        context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
        context.clip();
        const visiblePixelStart = Math.max(0, -left);
        const visiblePixelEnd = Math.min(width, snapshot.width - left);
        // El namespace sigue el zoom VISIBLE, cuantizado por la caché. Usar el
        // valor confirmado por React dejaba el mismo bitmap estirándose durante
        // todo el debounce de rueda/pinza: era el difuminado de ~100 ms que se
        // veía antes de que la onda volviese a enfocarse.
        const renderPixelsPerSecond = getWaveformRenderPixelsPerSecond(
          snapshot.zoomLevel,
        );
        const renderScale = snapshot.zoomLevel / renderPixelsPerSecond;
        const renderClipPixelWidth = Math.max(1, clip.durationSeconds * renderPixelsPerSecond);
        const visibleRenderPixelStart = visiblePixelStart / renderScale;
        const visibleRenderPixelEnd = visiblePixelEnd / renderScale;
        const startTileIndex = Math.max(0, Math.floor(visibleRenderPixelStart / WAVEFORM_TILE_WIDTH_PX));
        const endTileIndex = Math.max(
          startTileIndex,
          Math.ceil(visibleRenderPixelEnd / WAVEFORM_TILE_WIDTH_PX) - 1,
        );

        for (let tileIndex = startTileIndex; tileIndex <= endTileIndex; tileIndex += 1) {
          const tileStartPixel = tileIndex * WAVEFORM_TILE_WIDTH_PX;
          const tileEndPixel = Math.min(
            renderClipPixelWidth,
            tileStartPixel + WAVEFORM_TILE_WIDTH_PX,
          );
          const tileCenterX =
            left + ((tileStartPixel + tileEndPixel) / 2) * renderScale;
          const priority = Math.abs(tileCenterX - snapshot.width / 2);
          const tile = waveformTileCache.getTile({
            clip,
            waveform,
            pixelsPerSecond: renderPixelsPerSecond,
            clipPixelWidth: renderClipPixelWidth,
            tileIndex,
            laneHeightPx: clipHeight * waveformTilePixelRatio(),
            pixelRatio: waveformTilePixelRatio(),
            priority,
          });

          if (tile) {
            context.drawImage(
              tile.canvas,
              left + tile.tileStartPixel * renderScale,
              clipTop,
              tile.tileWidth * renderScale,
              clipHeight,
            );
            continue;
          }

          const fallbackSlices = waveformTileCache.getFallbackTileSlices({
            clip,
            waveform,
            pixelsPerSecond: renderPixelsPerSecond,
            clipPixelWidth: renderClipPixelWidth,
            tileIndex,
            laneHeightPx: clipHeight * waveformTilePixelRatio(),
            pixelRatio: waveformTilePixelRatio(),
            priority,
          });
          if (fallbackSlices) {
            for (const slice of fallbackSlices) {
              context.drawImage(
                slice.canvas,
                slice.sourceX,
                0,
                slice.sourceWidth,
                slice.canvas.height,
                left + slice.targetStartPixel * renderScale,
                clipTop,
                slice.targetWidth * renderScale,
                clipHeight,
              );
            }
            continue;
          }

          // Carga fría: no existe ningún nivel vecino todavía. Sólo en ese
          // caso se usa la envolvente barata mientras llega el primer tile.
          if (tileEndPixel <= tileStartPixel) {
            continue;
          }
          drawWaveformSketch(context, clip, waveform, {
            fromRatio: tileStartPixel / renderClipPixelWidth,
            toRatio: tileEndPixel / renderClipPixelWidth,
            left: left + tileStartPixel * renderScale,
            width: (tileEndPixel - tileStartPixel) * renderScale,
            top: clipTop,
            height: clipHeight,
          });
        }
        context.restore();

        if (clip.color || track.color) {
          context.save();
          context.beginPath();
          context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
          context.clip();
          context.fillStyle = `${clip.color ?? track.color}30`;
          context.fillRect(clippedLeft, clipTop, visibleWidth, clipHeight);
          context.restore();
        }
      } else {
        drawWaveformPlaceholder(context, clippedLeft, visibleWidth, clipTop, clipHeight);
      }

      if (visibleWidth >= 52) {
        context.save();
        context.beginPath();
        context.rect(clippedLeft, clipTop, visibleWidth, clipHeight);
        context.clip();
        context.fillStyle = "rgba(255, 255, 255, 0.34)";
        context.beginPath();
        context.roundRect(clippedLeft + 6, clipTop + 4, Math.min(visibleWidth - 12, 96), 18, 2);
        context.fill();
        context.fillStyle = "rgba(36, 38, 36, 0.95)";
        context.font = '600 10px "Space Grotesk", sans-serif';
        context.textBaseline = "middle";
        context.fillText(clipDisplayName(clip), clippedLeft + 12, clipTop + 13);
        context.restore();
      }
    }
  }

  context.strokeStyle = "rgba(229, 226, 225, 0.05)";
  context.lineWidth = 1;
  for (let index = visibleTrackStart + 1; index <= visibleTrackEnd; index += 1) {
    const y =
      Math.round(layout.tops[index] ?? layout.totalHeight) + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(snapshot.width, y);
    context.stroke();
  }
  context.restore();

  // Una sola publicación por pintado (no por tile): el HUD sólo necesita el
  // gauge, y así el coste no escala con el número de clips visibles.
  const tileStats = waveformTileCache.stats();
  reportWaveformTileCache(tileStats.entries, tileStats.bytes);
}

/**
 * Los tiles se rasterizan en píxeles de DISPOSITIVO: el lienzo ya está escalado
 * por `devicePixelRatio`, así que un carril de 60 px CSS en una pantalla 2x
 * necesita 120 px de tile para no verse borroso.
 */
function waveformTilePixelRatio() {
  const devicePixelRatio =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  // DPR 2 ya evita el reescalado visible. En móviles DPR 3–4, rasterizar al
  // valor completo haría que el LRU de 48 MiB expulsase tiles visibles.
  return clamp(devicePixelRatio, 1, 2);
}

/** Marca el inicio de un pintado: vacía la cola de tiles pendientes. */
export function beginWaveformTilePaint() {
  waveformTileCache.beginPaint();
}

/**
 * Rasteriza tiles encolados dentro del presupuesto del frame. La llama el
 * renderer DESPUÉS de pintar. Devuelve true si hizo algo, para que el frame
 * siguiente vuelva a pintar y los muestre.
 */
export function drainWaveformTileWork(
  budgetMs = WAVEFORM_TILE_FRAME_BUDGET_MS,
) {
  if (!waveformTileCache.hasPendingTiles()) {
    return false;
  }
  // Se mide la llamada ENTERA, no la suma de sus tiles: la diferencia entre
  // las dos es lo que cuesta asignar superficies y expulsar de la caché, que
  // es la hipótesis viva para los frames de 27-42 ms que sobrevivieron al
  // paso 04 (docs/plans/ui-performance/state/04.md).
  const startedAt = performance.now();
  const rendered = waveformTileCache.drainPendingTiles(budgetMs);
  recordTileDrain(performance.now() - startedAt);
  return rendered > 0;
}

export function buildTrackStructureSignature(song: SongView, visibleTracks: TimelineTrackSummary[]) {
  const trackStructureSignature = song.tracks
    .map((track) =>
      [track.id, track.kind, track.parentTrackId ?? "root", track.color ?? ""].join(":"),
    )
    .join("|");
  const visibleTrackOrderSignature = visibleTracks.map((track) => track.id).join("|");
  return `${trackStructureSignature}#visible=${visibleTrackOrderSignature}`;
}
