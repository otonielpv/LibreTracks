import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  getEffectiveBpmAt,
  markerCategory,
  regionEffectiveKey,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";
import {
  parseChordPro,
  transposeChart,
  type ChartDoc,
  type ChartLine,
} from "@libretracks/shared/charts/chordChart";
import { keyPrefersFlats, parseNoteRun } from "@libretracks/shared/charts/chordNotation";
import {
  buildPerformanceBlocks,
  NO_CHART_PLAYBACK,
  resolveChartPlayback,
  type ChartPlayback,
} from "@libretracks/shared/charts/chartSync";

import { getRemoteStrings } from "./i18n";

const STRINGS = getRemoteStrings();
const POLL_MS = 100;
const FONT_SCALE_KEY = "libretracks.remote.lyrics.fontScale";
const SHOW_CHORDS_KEY = "libretracks.remote.lyrics.showChords";
const FONT_SCALES = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];
const MANUAL_SCROLL_HOLD_MS = 4000;

function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode: the preference just does not stick.
  }
}

/** The song the lyrics follow: the one playing, else the next, else the first. */
export function lyricsRegionAt(
  regions: readonly SongRegionSummary[],
  positionSeconds: number,
): SongRegionSummary | null {
  const sorted = [...regions].sort((left, right) => left.startSeconds - right.startSeconds);
  return (
    sorted.find((region) => positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds) ??
    sorted.find((region) => region.startSeconds > positionSeconds) ??
    sorted[0] ??
    null
  );
}

/** Section markers of a song, in timeline order (cues never move the lyrics). */
export function lyricsMarkersFor(
  markers: readonly SectionMarkerSummary[],
  region: SongRegionSummary | null,
): SectionMarkerSummary[] {
  if (!region) return [];
  return markers
    .filter(
      (marker) =>
        markerCategory(marker) === "section" &&
        marker.startSeconds >= region.startSeconds - 0.001 &&
        marker.startSeconds < region.endSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

type LyricsState = { regionId: string | null; playback: ChartPlayback };

function sameState(left: LyricsState, right: LyricsState) {
  return (
    left.regionId === right.regionId &&
    left.playback.markerId === right.playback.markerId &&
    left.playback.line === right.playback.line
  );
}

function LyricLine({
  line,
  showChords,
  state,
  lineKey,
}: {
  line: ChartLine;
  showChords: boolean;
  state: "current" | "past" | "upcoming";
  lineKey: string;
}) {
  if (line.kind === "comment") {
    return <p className={`lyrics-comment is-${state}`} data-line-key={lineKey}>{line.text}</p>;
  }
  if (line.kind === "tab") {
    const notes = parseNoteRun(line.text);
    if (notes) {
      return (
        <p className={`lyrics-line lyrics-notes is-${state}`} data-line-key={lineKey}>
          {notes.map((group, index) =>
            group[0] === "‖" ? (
              <span key={index} className="lyrics-notes-bar" aria-hidden="true">‖</span>
            ) : (
              <span key={index} className="lyrics-chord">{group.join(" ")}</span>
            ),
          )}
        </p>
      );
    }
    return <pre className={`lyrics-tab is-${state}`} data-line-key={lineKey}>{line.text}</pre>;
  }
  const hasChords = showChords && line.segments.some((segment) => segment.chord);
  const hasText = line.segments.some((segment) => segment.text.trim());
  return (
    <p className={`lyrics-line is-${state}${hasText ? "" : " is-chords-only"}`} data-line-key={lineKey}>
      {line.segments.map((segment, index) => (
        <span className="lyrics-segment" key={index}>
          {hasChords ? <span className="lyrics-chord">{segment.chord ?? " "}</span> : null}
          {hasText || !hasChords ? <span className="lyrics-text">{segment.text || " "}</span> : null}
        </span>
      ))}
    </p>
  );
}

type LyricsWidgetProps = {
  songView: SongView | null;
  /** Live playhead, read on a timer (never a React prop that changes at 60 fps). */
  getPositionSeconds: () => number;
  /** A scheduled jump's target marker, shown right after the part playing. */
  pendingMarkerId: string | null;
};

/**
 * The song's lyrics and chords on the remote, read along with the song: the
 * same blocks the desktop live view shows (playing order, current line,
 * chords in the key the song is played in). Charts are made on the desktop;
 * here they are only read.
 */
export const LyricsWidget = memo(function LyricsWidget({
  songView,
  getPositionSeconds,
  pendingMarkerId,
}: LyricsWidgetProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const manualScrollAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [fontScale, setFontScale] = useState(() =>
    readStored(FONT_SCALE_KEY, 1, (raw) => (FONT_SCALES.includes(Number(raw)) ? Number(raw) : null)),
  );
  const [showChords, setShowChords] = useState(() =>
    readStored(SHOW_CHORDS_KEY, true, (raw) => raw === "true"),
  );

  const sources = useRef({ songView, getPositionSeconds });
  sources.current = { songView, getPositionSeconds };
  const docs = useRef(new Map<string, { text: string; transpose: number; doc: ChartDoc }>());

  const docFor = (region: SongRegionSummary | null): ChartDoc | null => {
    if (!region?.chart) return null;
    const cached = docs.current.get(region.id);
    if (cached && cached.text === region.chart.text && cached.transpose === region.transposeSemitones) {
      return cached.doc;
    }
    const doc = transposeChart(
      parseChordPro(region.chart.text),
      region.transposeSemitones,
      keyPrefersFlats(regionEffectiveKey(region)),
    );
    docs.current.set(region.id, { text: region.chart.text, transpose: region.transposeSemitones, doc });
    return doc;
  };

  const resolve = (): LyricsState => {
    const { songView: view, getPositionSeconds: position } = sources.current;
    if (!view) return { regionId: null, playback: NO_CHART_PLAYBACK };
    const seconds = position();
    const region = lyricsRegionAt(view.regions, seconds);
    const doc = docFor(region);
    if (!region || !doc || !region.chart) return { regionId: region?.id ?? null, playback: NO_CHART_PLAYBACK };
    return {
      regionId: region.id,
      playback: resolveChartPlayback(
        doc,
        region.chart.links,
        lyricsMarkersFor(view.sectionMarkers, region),
        region.endSeconds,
        seconds,
        (at) => 60 / Math.max(1, getEffectiveBpmAt(view, at)),
      ),
    };
  };
  const [state, setState] = useState<LyricsState>(resolve);

  useEffect(() => {
    const tick = () => {
      const next = resolve();
      setState((current) => (sameState(current, next) ? current : next));
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
    // Sources are read through refs; the timer lives as long as the widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const region = songView?.regions.find((candidate) => candidate.id === state.regionId) ?? null;
  const doc = docFor(region);
  const markers = useMemo(
    () => lyricsMarkersFor(songView?.sectionMarkers ?? [], region),
    [songView?.sectionMarkers, region],
  );
  const blocks = useMemo(
    () =>
      doc && region?.chart
        ? buildPerformanceBlocks(doc, region.chart.links, markers, state.playback.markerId, pendingMarkerId)
        : [],
    [doc, region?.chart, markers, state.playback.markerId, pendingMarkerId],
  );
  const currentBlock = blocks.findIndex((block) => !block.queued && block.markerId === state.playback.markerId);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || currentBlock < 0) return;
    if (performance.now() - manualScrollAtRef.current < MANUAL_SCROLL_HOLD_MS) return;
    const key = state.playback.line === null ? `${currentBlock}-head` : `${currentBlock}-${state.playback.line}`;
    const target = scroller.querySelector<HTMLElement>(`[data-line-key="${key}"]`);
    if (!target) return;
    // From on-screen positions, not offsetTop (see the desktop panel).
    const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const top = Math.max(0, scroller.scrollTop + offset - scroller.clientHeight * 0.18);
    if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: "smooth" });
    else scroller.scrollTop = top;
  }, [currentBlock, state.playback.line, fontScale, showChords]);

  const changeFont = (step: 1 | -1) => {
    const index = FONT_SCALES.indexOf(fontScale);
    const next = FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, index + step))];
    setFontScale(next);
    store(FONT_SCALE_KEY, String(next));
  };
  const toggleChords = () => {
    setShowChords((current) => {
      store(SHOW_CHORDS_KEY, String(!current));
      return !current;
    });
  };
  const markManual = () => {
    manualScrollAtRef.current = performance.now();
  };

  return (
    <div className="lyrics-widget" style={{ "--lyrics-font-scale": fontScale } as CSSProperties}>
      <div className="lyrics-toolbar">
        <span className="lyrics-title">{doc?.title || region?.name || STRINGS.widgetLyrics}</span>
        <button type="button" onClick={() => changeFont(-1)} aria-label={STRINGS.lyricsSmaller}>A−</button>
        <button type="button" onClick={() => changeFont(1)} aria-label={STRINGS.lyricsBigger}>A+</button>
        <button
          type="button"
          className={showChords ? "is-active" : ""}
          aria-pressed={showChords}
          onClick={toggleChords}
          aria-label={STRINGS.lyricsShowChords}
        >
          ♪
        </button>
      </div>
      {!region || !doc ? (
        <div className="lyrics-empty">{region ? STRINGS.lyricsNone : STRINGS.songNoActive}</div>
      ) : (
        <div
          ref={scrollerRef}
          className="lyrics-scroller"
          onWheel={markManual}
          onTouchStart={markManual}
          onPointerDown={markManual}
          data-testid="lyrics-scroller"
        >
          {blocks.map((block, blockIndex) => {
            const isCurrent = blockIndex === currentBlock;
            const section = block.section === null ? null : doc.sections[block.section];
            return (
              <div
                key={block.key}
                className={`lyrics-block${isCurrent ? " is-current" : ""}${blockIndex < currentBlock ? " is-past" : ""}${block.queued ? " is-queued" : ""}`}
              >
                <h3 className="lyrics-block-label" data-line-key={`${blockIndex}-head`}>
                  {block.queued && blockIndex > 0 && !blocks[blockIndex - 1].queued ? (
                    <em className="lyrics-jump-badge">{STRINGS.lyricsJump}</em>
                  ) : null}
                  {block.label}
                </h3>
                {section?.lines.map((line, lineIndex) => (
                  <LyricLine
                    key={lineIndex}
                    line={line}
                    showChords={showChords}
                    lineKey={`${blockIndex}-${lineIndex}`}
                    state={
                      !isCurrent || state.playback.line === null
                        ? blockIndex < currentBlock ? "past" : "upcoming"
                        : lineIndex === state.playback.line
                          ? "current"
                          : lineIndex < state.playback.line
                            ? "past"
                            : "upcoming"
                    }
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
