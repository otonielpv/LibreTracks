import { useNetworkPermissions } from "../../../network/useNetworkPermissions";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  markerCategory,
  markerColor,
  type ClipSummary,
  type SongRegionSummary,
  type SongView,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";

import type { CompactMixerHandlers } from "../../compact/CompactMixer";
import { isMobileApp } from "../../desktopApi";
import {
  cancelGatedFrame,
  markFrameActivity,
  requestGatedFrame,
  useFrameGateWake,
} from "../../frameGate";
import { formatMusicalPosition } from "../../helpers";
import type { ShortcutActionId } from "../../keyboard/actions";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { useTouchContextMenu } from "../../timeline/useTouchContextMenu";
import { useTimelineUIStore } from "../../uiStore";
import { LANES_MAX_ZOOM, LANES_MIN_ZOOM, useSetlistStore } from "../setlistStore";
import { barSecondsAtFor } from "../songMapModel";
import { createSongTimeScale } from "../songTimeScale";
import { computeSongTrackContent } from "../songTrackContent";
import type { SetlistLayoutClass } from "../useSetlistLayout";
import { audioLaneType } from "./AudioLane";
import { AutomationLane } from "./AutomationLane";
import { TempoLane } from "./TempoLane";
import { midiLaneType } from "./MidiLane";
import { videoLaneType } from "./VideoLane";
import type { VideoLaneBindings } from "../../video/VideoClipHotspots";
import { useVideoStore } from "../../video/videoStore";
import { addVideoAt as addVideo } from "../addVideo";
import { automationRowIndex, sectionAt } from "./automationLaneModel";
import { createLaneClipHandlers, type LaneClipHandlerDeps } from "./laneClipHandlers";
import type { SongLaneType } from "./laneTypes";
import { clearLanePreviews, useClipGestures } from "./useClipGestures";

export const DEFAULT_LANE_TYPES: SongLaneType[] = [midiLaneType, videoLaneType, audioLaneType];

type SongLanesProps = {
  song: SongView;
  region: SongRegionSummary;
  tracks: TrackSummary[];
  waveformSummaries: Readonly<Record<string, WaveformSummaryDto>>;
  positionSecondsRef: { readonly current: number };
  layout: SetlistLayoutClass;
  menus: TimelineMenus;
  mixerHandlers: CompactMixerHandlers;
  /** The DAW's shortcut dispatcher: split, duplicate and delete are ITS
   * actions on the project's clip selection. */
  runShortcutAction: (action: ShortcutActionId) => void;
  onSeek: (seconds: number) => void;
  /** Right click on the ruler: the DAW ruler menu at that point. */
  onRulerMenuAt: (event: ReactMouseEvent<HTMLElement>, seconds: number) => void;
  runAction: LaneClipHandlerDeps["runAction"];
  onSnapshotApplied: (snapshot: TransportSnapshot) => void;
  /** Lane kinds; steps 12-15 add theirs. */
  laneTypes?: SongLaneType[];
  /** The video feature's lane bindings (useVideoFeature, once per panel). */
  videoLanes?: VideoLaneBindings;
  /** The same song in the DAW (step 17). */
  onOpenInDaw?: () => void;
};

const MIN_TICK_SPACING_PX = 44;
const ZOOM_STEP = 2;
const WHEEL_ZOOM_FACTOR = 1.25;

/**
 * Edit → Lanes: the editor of ONE song (00-DISENO §4, D2). The song always
 * fits at 1× and zooms up to 16× inside itself; the view never follows the
 * playhead on its own (there is a button for that). Zoom and scroll live in
 * setlistStore, never in the DAW's camera. Every row is a registered lane
 * type; the clips are DOM boxes on the view's one time scale.
 */
function SongLanesComponent({
  song,
  region,
  tracks,
  waveformSummaries,
  positionSecondsRef,
  layout,
  menus,
  mixerHandlers,
  runShortcutAction,
  onSeek,
  onRulerMenuAt,
  runAction,
  onSnapshotApplied,
  laneTypes = DEFAULT_LANE_TYPES,
  videoLanes,
  onOpenInDaw,
}: SongLanesProps) {
  const { canUseFiles } = useNetworkPermissions();
  const { t } = useTranslation();
  useFrameGateWake();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rulerCellRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  const [namesCollapsed, setNamesCollapsed] = useState(false);
  const zoom = useSetlistStore((state) => state.lanesZoom);
  const scrollPx = useSetlistStore((state) => state.lanesScrollPx);
  const setZoom = useSetlistStore((state) => state.setLanesZoom);
  const setScrollPx = useSetlistStore((state) => state.setLanesScrollPx);
  const selectedClipIds = useTimelineUIStore((state) => state.selectedClipIds);
  const selectedVideoClipIds = useVideoStore((state) => state.selectedVideoClipIds);
  const touchMenu = useTouchContextMenu();

  useLayoutEffect(() => {
    const element = rulerCellRef.current;
    if (!element) return;
    setWidthPx(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) setWidthPx((current) => (current === Math.round(rect.width) ? current : Math.round(rect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = createSongTimeScale({
    startSeconds: region.startSeconds,
    endSeconds: region.endSeconds,
    widthPx,
    zoom,
    scrollPx,
  });

  const rows = useMemo(() => {
    const content = computeSongTrackContent(song, region);
    return tracks
      .map((track) => ({ track, type: laneTypes.find((type) => type.accepts(track)) ?? null }))
      .filter(
        (row): row is { track: TrackSummary; type: SongLaneType } =>
          row.type !== null && (content.trackIds.has(row.track.id) || row.type.showEmpty === true),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneTypes, region.endSeconds, region.startSeconds, song.clips, song.midiClips, song.videoClips, tracks]);

  const clipHandlersDepsRef = useRef<LaneClipHandlerDeps>({ runAction, applySnapshot: onSnapshotApplied });
  clipHandlersDepsRef.current = { runAction, applySnapshot: onSnapshotApplied };
  const clipHandlers = useMemo(() => createLaneClipHandlers(() => clipHandlersDepsRef.current), []);
  const onClipPointerDown = useClipGestures(rootRef, {
    song,
    region,
    scale,
    clipHandlers,
    getPlayheadSeconds: () => positionSecondsRef.current,
  });
  // A new snapshot puts every clip where the model says: drop any preview.
  useLayoutEffect(() => clearLanePreviews(rootRef.current), [song.clips]);

  const laneProps = (track: TrackSummary) => ({
    track,
    song,
    region,
    scale,
    layout,
    waveformSummaries,
    editable: true,
    onClipPointerDown,
    onClipContextMenu,
    menus,
    video: videoLanes,
  });

  const onClipContextMenu = (event: ReactMouseEvent<HTMLElement>, clip: ClipSummary) => {
    event.preventDefault();
    event.stopPropagation();
    if (!useTimelineUIStore.getState().selectedClipIds.includes(clip.id)) {
      useTimelineUIStore.getState().selectClip(clip.id, clip.trackId);
    }
    menus.openMenu(event, clip.filePath.split(/[\\/]/).pop() ?? clip.id, menus.clipContextMenu(clip));
  };

  // The playhead, by rAF: no render while it plays (rule 5).
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    let frameId = 0;
    let lastX = Number.NaN;
    let lastVisible: boolean | null = null;
    const frame = () => {
      const element = playheadRef.current;
      const cell = rulerCellRef.current;
      const current = scaleRef.current;
      const position = positionSecondsRef.current;
      const x = current.secondsToPx(position);
      const visible =
        position >= current.startSeconds && position < current.endSeconds && x >= 0 && x <= current.widthPx;
      if (element) {
        if (visible !== lastVisible) {
          element.style.setProperty("visibility", visible ? "visible" : "hidden");
          lastVisible = visible;
          markFrameActivity();
        }
        const left = (cell?.offsetLeft ?? 0) + x;
        if (visible && left !== lastX) {
          element.style.setProperty("transform", `translate3d(${left}px, 0, 0)`);
          lastX = left;
          markFrameActivity();
        }
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
  }, [positionSecondsRef]);

  // Ruler: one tick per bar where there is room for its number.
  const ticks = useMemo(() => {
    const barSecondsAt = barSecondsAtFor(song);
    const result: Array<{ seconds: number; label: string }> = [];
    let seconds = region.startSeconds;
    let guard = 0;
    while (seconds < region.endSeconds && guard < 4000) {
      result.push({ seconds, label: formatMusicalPosition(seconds, song).split(".")[0] });
      const step = barSecondsAt(seconds);
      if (!(step > 0)) break;
      seconds += step;
      guard += 1;
    }
    return result;
  }, [region.endSeconds, region.startSeconds, song]);
  const tickEvery = Math.max(
    1,
    Math.ceil(
      MIN_TICK_SPACING_PX /
        Math.max(1e-6, ((region.endSeconds - region.startSeconds) / Math.max(1, ticks.length)) * scale.pxPerSecond),
    ),
  );
  // The DAW's synthetic automation track, in its place among the rows.
  const automationIndex = song.automationTrack
    ? automationRowIndex(
        rows.map((row) => row.track.id),
        tracks.map((track) => track.id),
        song.automationTrack.afterTrackId,
      )
    : -1;
  const automationRow =
    automationIndex >= 0 ? (
      <AutomationLane
        key="automation"
        song={song}
        region={region}
        scale={scale}
        menus={menus}
        positionSecondsRef={positionSecondsRef}
      />
    ) : null;
  // «+ MIDI»: a clip at the playhead or at the start of its section, on the
  // MIDI track picked in the menu (the DAW's create, then its modal).
  const midiTracks = tracks.filter((track) => track.kind === "midi");
  const openAddMidiMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const playhead = scale.clampSeconds(positionSecondsRef.current);
    const sectionStart = sectionAt(song, region, playhead)?.startSeconds ?? region.startSeconds;
    menus.openMenu(
      event,
      t("setlistView.midi.add"),
      midiTracks.flatMap((track) => [
        {
          label: t("setlistView.midi.atPlayhead", { name: track.name }),
          onSelect: () => menus.createMidiClipAt(track.id, playhead),
        },
        {
          label: t("setlistView.midi.atSection", { name: track.name }),
          onSelect: () => menus.createMidiClipAt(track.id, sectionStart),
        },
      ]),
    );
  };
  // «+ Video»: the DAW's import (with its «extract the audio?» question) at
  // the playhead or the start of its section, on the selected video track,
  // else the song's first one, else a new one. A phone picks from its gallery.
  const canAddVideo = canUseFiles && Boolean(videoLanes && !videoLanes.readOnly);
  const addVideoAt = (seconds: number) => {
    if (videoLanes) addVideo(videoLanes, tracks, seconds);
  };
  const openAddVideoMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const playhead = scale.clampSeconds(positionSecondsRef.current);
    const sectionStart = sectionAt(song, region, playhead)?.startSeconds ?? region.startSeconds;
    menus.openMenu(event, t("setlistView.video.add"), [
      { label: t("setlistView.video.atPlayhead"), onSelect: () => addVideoAt(playhead) },
      { label: t("setlistView.video.atSection"), onSelect: () => addVideoAt(sectionStart) },
    ]);
  };
  const addCueAtSectionStart = () => {
    const playhead = scale.clampSeconds(positionSecondsRef.current);
    menus.createAutomationCueAt(sectionAt(song, region, playhead)?.startSeconds ?? region.startSeconds);
  };

  const sections = song.sectionMarkers.filter(
    (marker) =>
      markerCategory(marker) === "section" &&
      marker.startSeconds >= region.startSeconds &&
      marker.startSeconds < region.endSeconds,
  );

  const rulerSecondsAt = (clientX: number) => {
    const cell = rulerCellRef.current;
    if (!cell) return region.startSeconds;
    const rect = cell.getBoundingClientRect();
    const zoomFactor = rect.width > 0 ? cell.offsetWidth / rect.width : 1;
    return scale.clampSeconds(scale.pxToSeconds((clientX - rect.left) * (zoomFactor || 1)));
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const cell = rulerCellRef.current;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const nextZoom = Math.max(
        LANES_MIN_ZOOM,
        Math.min(LANES_MAX_ZOOM, zoom * (event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR)),
      );
      if (nextZoom === zoom || !cell) return;
      // Keep the second under the pointer where it is.
      const rect = cell.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const anchor = scale.pxToSeconds(localX);
      const nextScale = createSongTimeScale({ ...scale, zoom: nextZoom, scrollPx: 0 });
      setZoom(nextZoom);
      setScrollPx(nextScale.secondsToPx(anchor) - localX);
      return;
    }
    const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
    if (zoom > 1 && horizontal !== 0) setScrollPx(scale.scrollPx + horizontal);
  };

  const changeZoom = (factor: number) => {
    const nextZoom = Math.max(LANES_MIN_ZOOM, Math.min(LANES_MAX_ZOOM, zoom * factor));
    // Keep the centre of the view where it is.
    const centre = scale.pxToSeconds(scale.widthPx / 2);
    const nextScale = createSongTimeScale({ ...scale, zoom: nextZoom, scrollPx: 0 });
    setZoom(nextZoom);
    setScrollPx(nextScale.secondsToPx(centre) - scale.widthPx / 2);
  };

  const goToPlayhead = () => {
    const unscrolled = createSongTimeScale({ ...scale, scrollPx: 0 });
    setScrollPx(unscrolled.secondsToPx(positionSecondsRef.current) - scale.widthPx / 3);
  };

  const openSelectionMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const clip = song.clips.find((candidate) => candidate.id === selectedClipIds[0]);
    if (clip) onClipContextMenu(event, clip);
  };

  // Split, duplicate and delete are the DAW's shortcut actions, which act on
  // the video selection as well as the audio one.
  const hasSelection = selectedClipIds.length > 0 || selectedVideoClipIds.length > 0;
  const toolbar = (
    <div className="lt-setlist-lanes-toolbar" role="toolbar" aria-label={t("setlistView.lanes.toolbar")}>
      <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.lanes.zoomOut")} title={t("setlistView.lanes.zoomOut")} disabled={zoom <= LANES_MIN_ZOOM} onClick={() => changeZoom(1 / ZOOM_STEP)}>
        −
      </button>
      <output className="lt-setlist-settings-value" aria-label={t("setlistView.lanes.zoom")}>{`${Math.round(zoom * 10) / 10}×`}</output>
      <button type="button" className="lt-setlist-settings-button" aria-label={t("setlistView.lanes.zoomIn")} title={t("setlistView.lanes.zoomIn")} disabled={zoom >= LANES_MAX_ZOOM} onClick={() => changeZoom(ZOOM_STEP)}>
        +
      </button>
      <button type="button" className="lt-setlist-settings-button" onClick={goToPlayhead}>
        <span className="material-symbols-outlined" aria-hidden="true">my_location</span>
        {t("setlistView.lanes.goToPlayhead")}
      </button>
      <button
        type="button"
        className="lt-setlist-settings-button"
        title={t("setlistView.tempo.addTempoTitle")}
        onClick={() => void menus.changeTimelineBpmAt(scale.clampSeconds(positionSecondsRef.current))}
      >
        <span className="material-symbols-outlined" aria-hidden="true">speed</span>
        {t("setlistView.tempo.addTempo")}
      </button>
      <button
        type="button"
        className="lt-setlist-settings-button"
        title={t("setlistView.tempo.addMeterTitle")}
        onClick={() => void menus.createTimeSignatureMarkerAt(scale.clampSeconds(positionSecondsRef.current))}
      >
        {t("setlistView.tempo.addMeter")}
      </button>
      {song.automationTrack ? (
        <button type="button" className="lt-setlist-settings-button" title={t("setlistView.automation.addAtSectionTitle")} onClick={addCueAtSectionStart}>
          <span className="material-symbols-outlined" aria-hidden="true">bolt</span>
          {t("setlistView.automation.addAtSection")}
        </button>
      ) : (
        <button
          type="button"
          className="lt-setlist-settings-button"
          onClick={() => void menus.handleAddAutomationTrack(rows.at(-1)?.track.id ?? null)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">bolt</span>
          {t("transport.automation.addTrack")}
        </button>
      )}
      {midiTracks.length > 0 ? (
        <button
          type="button"
          className="lt-setlist-settings-button"
          aria-haspopup="menu"
          title={t("setlistView.midi.addTitle")}
          onClick={openAddMidiMenu}
        >
          <span className="material-symbols-outlined" aria-hidden="true">piano</span>
          {t("setlistView.midi.add")}
        </button>
      ) : null}
      {canAddVideo ? (
        <button
          type="button"
          className="lt-setlist-settings-button"
          aria-haspopup="menu"
          title={t("setlistView.video.addTitle")}
          onClick={openAddVideoMenu}
        >
          <span className="material-symbols-outlined" aria-hidden="true">movie</span>
          {t("setlistView.video.add")}
        </button>
      ) : null}
      <span className="lt-setlist-lanes-toolbar-gap" />
      {onOpenInDaw ? (
        <button type="button" className="lt-setlist-settings-button" title={t("setlistView.daw.openTitle")} onClick={onOpenInDaw}>
          <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
          {t("setlistView.daw.open")}
        </button>
      ) : null}
      <button type="button" className="lt-setlist-settings-button" disabled={!hasSelection} aria-label={t("setlistView.lanes.split")} title={t("setlistView.lanes.split")} onClick={() => runShortcutAction("edit.splitClip")}>
        <span className="material-symbols-outlined" aria-hidden="true">content_cut</span>
      </button>
      <button type="button" className="lt-setlist-settings-button" disabled={!hasSelection} aria-label={t("setlistView.lanes.duplicate")} title={t("setlistView.lanes.duplicate")} onClick={() => runShortcutAction("edit.duplicate")}>
        <span className="material-symbols-outlined" aria-hidden="true">content_copy</span>
      </button>
      <button type="button" className="lt-setlist-settings-button" disabled={!hasSelection} aria-label={t("setlistView.lanes.delete")} title={t("setlistView.lanes.delete")} onClick={() => runShortcutAction("edit.delete")}>
        <span className="material-symbols-outlined" aria-hidden="true">delete</span>
      </button>
      <button type="button" className="lt-setlist-settings-button" disabled={!hasSelection} aria-label={t("setlistView.lanes.menu")} title={t("setlistView.lanes.menu")} onClick={openSelectionMenu}>
        <span className="material-symbols-outlined" aria-hidden="true">more_horiz</span>
      </button>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`lt-setlist-lanes is-${layout}${namesCollapsed ? " is-names-collapsed" : ""}`}
      onWheel={handleWheel}
      onPointerDownCapture={isMobileApp ? touchMenu.begin : undefined}
      onPointerMoveCapture={isMobileApp ? touchMenu.move : undefined}
      onPointerUpCapture={isMobileApp ? touchMenu.cancel : undefined}
      onPointerCancelCapture={isMobileApp ? touchMenu.cancel : undefined}
    >
      {layout === "short" ? null : toolbar}
      <div className="lt-setlist-lanes-body">
        <div className="lt-setlist-lane-row is-ruler">
          <div className="lt-setlist-lane-header">
            {layout === "short" ? (
              <button
                type="button"
                className="lt-setlist-settings-button"
                aria-pressed={namesCollapsed}
                aria-label={t("setlistView.lanes.collapseNames")}
                title={t("setlistView.lanes.collapseNames")}
                onClick={() => setNamesCollapsed((value) => !value)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {namesCollapsed ? "chevron_right" : "chevron_left"}
                </span>
              </button>
            ) : null}
          </div>
          <div
            ref={rulerCellRef}
            className="lt-setlist-lane-cell lt-setlist-lanes-ruler"
            aria-label={t("setlistView.lanes.ruler")}
            onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
              if (event.button === 0) onSeek(rulerSecondsAt(event.clientX));
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              onRulerMenuAt(event, rulerSecondsAt(event.clientX));
            }}
          >
            {ticks.map((tick, index) => {
              const x = scale.secondsToPx(tick.seconds);
              if (x < -1 || x > scale.widthPx + 1) return null;
              return (
                <span key={tick.seconds} className="lt-setlist-lanes-tick" style={{ left: `${x}px` }}>
                  {index % tickEvery === 0 ? tick.label : null}
                </span>
              );
            })}
            {sections.map((marker) => (
              <span
                key={marker.id}
                className="lt-setlist-lanes-section"
                style={
                  {
                    left: `${scale.secondsToPx(marker.startSeconds)}px`,
                    "--lt-setlist-block-color": markerColor(marker),
                  } as CSSProperties
                }
              >
                {marker.name}
              </span>
            ))}
          </div>
        </div>
        <TempoLane song={song} region={region} scale={scale} menus={menus} />
        {rows.length === 0 && !automationRow ? <p className="lt-setlist-tracks-empty">{t("setlistView.lanes.empty")}</p> : null}
        {automationIndex === 0 ? automationRow : null}
        {rows.map(({ track, type }, index) => (
          <Fragment key={track.id}>
          <div
            className="lt-setlist-lane-row"
            style={{ height: `${type.rowHeight}px`, "--lt-track-color": track.color ?? undefined } as CSSProperties}
          >
            <div className="lt-setlist-lane-header" title={track.name}>
              {type.renderHeader ? type.renderHeader(laneProps(track)) : (
              <>
              <span className="lt-setlist-track-swatch" aria-hidden="true" />
              <strong className="lt-setlist-lane-name">{track.name}</strong>
              <button
                type="button"
                className={`lt-setlist-lane-toggle${track.muted ? " is-active" : ""}`}
                aria-pressed={track.muted}
                aria-label={t("setlistView.lanes.mute", { name: track.name })}
                title={t("setlistView.lanes.mute", { name: track.name })}
                onClick={() => mixerHandlers.onToggleMute(track.id)}
              >
                M
              </button>
              <button
                type="button"
                className={`lt-setlist-lane-toggle${track.solo ? " is-active" : ""}`}
                aria-pressed={track.solo}
                aria-label={t("setlistView.lanes.solo", { name: track.name })}
                title={t("setlistView.lanes.solo", { name: track.name })}
                onClick={() => mixerHandlers.onToggleSolo(track.id)}
              >
                S
              </button>
              </>
              )}
            </div>
            <div className="lt-setlist-lane-cell">
              {type.render(laneProps(track))}
            </div>
          </div>
          {automationIndex === index + 1 ? automationRow : null}
          </Fragment>
        ))}
        <div ref={playheadRef} className="lt-setlist-lanes-playhead" aria-hidden="true" />
      </div>
      {layout === "short" ? toolbar : null}
    </div>
  );
}

export const SongLanes = memo(SongLanesComponent);
