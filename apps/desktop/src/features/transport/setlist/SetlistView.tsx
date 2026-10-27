import { memo, useCallback, useEffect, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNetworkPermissions } from "../../network/useNetworkPermissions";

import type { TimelineMenus } from "../menus/timelineMenus";
import { MarkerPositionEditor } from "../timeline/MarkerPositionEditor";
import type {
  PerformanceBindings,
  SongViewBindings,
} from "../songs/songViewBindings";
import { SetlistSongRow, type SetlistDragPreview } from "./SetlistSongRow";
import { SongMap } from "./SongMap";
import { SongOverviewStrip } from "./SongOverviewStrip";
import { SetlistMixer } from "./SetlistMixer";
import { MIXER_HEIGHT_VAR, useMixerResize } from "./useMixerResize";
import { SONGS_HEIGHT_VAR, useSongsRowResize } from "./useSongsRowResize";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { OverviewZoom } from "./OverviewZoom";
import { SetlistLyrics } from "./SetlistLyrics";
import { waveformEditModes } from "./waveformEditModes";
import { WaveDock } from "./WaveDock";
import { SetlistEditButton, SetlistEditDrawer } from "./SetlistEditDrawer";
import { SetlistSongSettings } from "./SetlistSongSettings";
import { SetlistSectionsPanel } from "./SetlistSectionsPanel";
import { SetlistTrackList } from "./SetlistTrackList";
import {
  SetlistArrangementEditor,
  SetlistArrangementPicker,
  SetlistArrangementToolbar,
} from "./SetlistArrangement";
import { SongSectionEditLayer } from "./SongSectionEditLayer";
import { SongLanes } from "./lanes/SongLanes";
import { createSectionEditHandlers, type SectionEditDeps } from "./sectionEditHandlers";
import { useTimelineUIStore } from "../uiStore";
import { resolveSetlistSongId } from "./songMapModel";
import { resolveSongSeekSeconds } from "./sectionScrubModel";
import { SONG_DROP_CLASS, songDropHandlers } from "./songDrop";
import { requestEditMode, useSetlistStore } from "./setlistStore";
import { useSetlistLayout, type SetlistLayoutClass } from "./useSetlistLayout";
import "./setlist.css";

/** "overview" is the song band: the waveform with the sections on it. */
export type SetlistZone = "songs" | "overview" | "mixer" | "drawer" | "lyrics";

export type SetlistViewProps = SongViewBindings & {
  performance: PerformanceBindings;
  /** The DAW's context menus and modals, passed whole (stable: useMemo([])). */
  menus: TimelineMenus;
  /** Shortcut to the same song in the DAW (step 17). */
  onOpenInDaw: (regionId: string) => void;
  /** The panel's native/library drag-over preview (same as Compacta's). */
  dragPreview?: SetlistDragPreview;
  /** Tests force the size class; otherwise it is measured. */
  layoutClass?: SetlistLayoutClass;
  /** The video feature's lane bindings (useVideoFeature, once per panel). */
  videoLanes?: VideoLaneBindings;
};

/** A named, empty slot the later steps fill without stepping on each other. */
function Zone({
  name,
  children,
  zoneRef,
  drop,
}: {
  name: SetlistZone;
  children?: ReactNode;
  zoneRef?: RefObject<HTMLElement | null>;
  /** Makes the zone a "drop audio into this song" target. */
  drop?: { regionId: string; active: boolean; handlers: ReturnType<typeof songDropHandlers> };
}) {
  return (
    <section
      ref={zoneRef}
      className={`lt-setlist-zone is-${name}${drop ? ` ${SONG_DROP_CLASS}` : ""}${drop?.active ? " is-drop-target" : ""}`}
      data-setlist-zone={name}
      data-region-id={drop?.regionId}
      onDragOver={drop?.handlers.onDragOver}
      onDrop={drop?.handlers.onDrop}
    >
      {children}
    </section>
  );
}

/**
 * The Setlist view, Playback-style (docs/plans/setlist-view): a row of song
 * cards, the selected song's section map over its waveform, and a mixer
 * console underneath. A pure projection of the same snapshot the DAW shows;
 * every action comes from the bindings or the DAW's own `menus`.
 *
 * This component only lays out the zones for the size class. Business logic
 * lives in the zone components and in setlistStore.
 */
function SetlistViewComponent({
  layoutClass,
  onOpenInDaw,
  videoLanes,
  menus,
  rulerMarkers,
  runShortcutAction,
  structureHandlers,
  clipsByRegion,
  onMoveClipToTrack,
  onDeleteClip,
  onAddAudioToSong,
  onSetSongKey,
  onResizeSong,
  onMoveSong,
  runAction,
  setStatus,
  onSelectedRegionTransposeChange,
  onSelectedRegionWarpToggle,
  onSelectedRegionTempoChange,
  tracks,
  audioRoutingOptions,
  mixerHandlers,
  onTrackContextMenu,
  selectedTrackIds,
  onTrackSelect,
  onTrackDragStart,
  collapsedFolders,
  onToggleFolder,
  onMasterGainChange,
  onMasterGainCommit,
  appSettings,
  auxHandlers,
  performance,
  dragPreview,
  regions,
  selectedRegionId,
  activeRegionId,
  pendingRegionId,
  bpmByRegion,
  onSelectRegion,
  onCueSong,
  onPlaySong,
  onSongContextMenu,
  onSectionContextMenu,
  onCommitMarkerPosition,
  workspaceEndSeconds,
  onReorderSong,
  waveformSummaries,
  onDropOsFilesIntoSong,
  onDropLibraryAssetsIntoSong,
  onSnapshotApplied,
  onImportSongPackageFromDialog,
  onImportSongPackageFromOsFile,
  onTapTempo,
}: SetlistViewProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement | null>(null);
  const layout = useSetlistLayout(rootRef, layoutClass);
  const editMode = useSetlistStore((state) => state.editMode);
  const { canEdit } = useNetworkPermissions();
  useEffect(() => {
    if (!canEdit) useSetlistStore.getState().setEditMode(null);
  }, [canEdit, editMode]);
  const waveEditing = editMode === "sections" || editMode === "arrangement";
  const getGridWidthPx = useCallback(() => {
    const root = rootRef.current;
    if (!root) return 0;
    const layer =
      root.querySelector<HTMLElement>(
        layout === "short"
          ? ".lt-setlist-scrub-layer, .lt-setlist-arrangement.is-waveform"
          : ".lt-setlist-zoom-layer",
      );
    const layerWidth = layer?.clientWidth || layer?.offsetWidth || 0;
    if (layerWidth > 0) return layerWidth;
    const waveform = root.querySelector<HTMLElement>(".lt-setlist-overview");
    return waveform?.clientWidth || waveform?.offsetWidth || 0;
  }, [layout]);
  const mixerCollapsed = useSetlistStore((state) => state.mixerCollapsed);
  const shortPane = useSetlistStore((state) => state.shortPane);
  const mixerExpanded = useSetlistStore((state) => state.mixerExpanded);
  const lyricsOpenSetting = useSetlistStore((state) => state.lyricsOpen);
  const setLyricsOpen = useSetlistStore((state) => state.setLyricsOpen);
  // Lyrics ship behind the same flag as Live's.
  const lyricsOpen = !waveEditing && FEATURE_FLAGS.lyrics && lyricsOpenSetting && layout !== "short";
  const lyricsPane = !waveEditing && FEATURE_FLAGS.lyrics && layout === "short" && shortPane === "lyrics";
  const setShortPane = useSetlistStore((state) => state.setShortPane);
  // The song the map, overview and mixer are about (00 §5 "Selección").
  const lastShownRegionIdRef = useRef<string | null>(null);
  const shownRegionId = resolveSetlistSongId(
    regions,
    selectedRegionId,
    lastShownRegionIdRef.current,
    activeRegionId,
  );
  lastShownRegionIdRef.current = shownRegionId;
  const shownRegion = regions.find((region) => region.id === shownRegionId) ?? null;
  const seekInWaveEditor = useCallback(
    (seconds: number) => {
      if (
        shownRegion &&
        (editMode === "sections" || editMode === "arrangement") &&
        useTimelineUIStore.getState().snapEnabled
      ) {
        performance.onSeek(resolveSongSeekSeconds(
          performance.song,
          shownRegion,
          seconds,
          true,
          getGridWidthPx(),
        ));
        return;
      }
      performance.onSeek(seconds);
    },
    [editMode, getGridWidthPx, performance.onSeek, performance.song, shownRegion],
  );
  // The band and the console take audio for the song they show.
  const songDrop = shownRegion
    ? {
        regionId: shownRegion.id,
        active: !dragPreview?.isPackage && dragPreview?.targetRegionId === shownRegion.id,
        handlers: songDropHandlers(shownRegion.id, { onDropOsFilesIntoSong, onDropLibraryAssetsIntoSong }),
      }
    : undefined;
  // Section editing (Edit → Sections): created once, fed through a ref.
  const sectionDepsRef = useRef<SectionEditDeps | null>(null);
  sectionDepsRef.current = {
    t,
    getSong: () => performance.song,
    getRegion: () => shownRegion,
    getPlayheadSeconds: () => performance.positionSecondsRef.current,
    getSnapEnabled: () => useTimelineUIStore.getState().snapEnabled,
    getGridWidthPx,
    menus,
    rulerMarkers,
    onSectionContextMenu,
    onResizeSong,
    workspaceEndSeconds,
  };
  const sectionHandlers = useMemo(
    () => createSectionEditHandlers(() => sectionDepsRef.current as SectionEditDeps),
    [],
  );
  // Editing in any mode, the sections and cues are handles on the waveform.
  const sectionLayer =
    editMode !== null && editMode !== "arrangement" && shownRegion ? (
      <SongSectionEditLayer song={performance.song} region={shownRegion} handlers={sectionHandlers} />
    ) : null;

  const trackList =
    shownRegion !== null ? (
      <SetlistTrackList
        song={performance.song}
        region={shownRegion}
        menus={menus}
        layout={layout}
        tracks={tracks}
        clipsByRegion={clipsByRegion}
        audioRoutingOptions={audioRoutingOptions}
        selectedTrackIds={selectedTrackIds}
        onTrackSelect={onTrackSelect}
        onTrackDragStart={onTrackDragStart}
        onTrackContextMenu={onTrackContextMenu}
        collapsedFolders={collapsedFolders}
        onToggleFolder={onToggleFolder}
        onDropOsFilesIntoSong={onDropOsFilesIntoSong}
        onDropLibraryAssetsIntoSong={onDropLibraryAssetsIntoSong}
        onMoveClipToTrack={onMoveClipToTrack}
        onDeleteClip={onDeleteClip}
        onAddAudioToSong={onAddAudioToSong}
      />
    ) : null;
  const lanes =
    shownRegion !== null ? (
      <SongLanes
        song={performance.song}
        region={shownRegion}
        tracks={tracks}
        waveformSummaries={waveformSummaries}
        positionSecondsRef={performance.positionSecondsRef}
        layout={layout}
        menus={menus}
        mixerHandlers={mixerHandlers}
        runShortcutAction={runShortcutAction}
        onSeek={performance.onSeek}
        onRulerMenuAt={sectionHandlers.openMenuAt}
        videoLanes={videoLanes}
        onOpenInDaw={() => onOpenInDaw(shownRegion.id)}
        runAction={runAction}
        onSnapshotApplied={onSnapshotApplied}
      />
    ) : null;
  // Editing acts on the project selection (the toolbar's selected-song
  // handlers), so entering edit mode selects the song the view shows.
  useEffect(() => {
    if (editMode !== null && shownRegionId && shownRegionId !== selectedRegionId) {
      onSelectRegion(shownRegionId);
    }
  }, [editMode, onSelectRegion, selectedRegionId, shownRegionId]);
  const drawer =
    editMode !== null ? (
      <Zone name="drawer">
        <SetlistEditDrawer
          layout={layout}
          songName={shownRegion?.name ?? null}
          modes={[
            {
              mode: "song",
              icon: "tune",
              labelKey: "setlistView.edit.modes.song",
              content: shownRegion ? (
                <SetlistSongSettings
                  song={performance.song}
                  region={shownRegion}
                  menus={menus}
                  regions={regions}
                  bpmByRegion={bpmByRegion}
                  appSettings={appSettings}
                  onSetSongKey={onSetSongKey}
                  onMasterGainChange={onMasterGainChange}
                  onMasterGainCommit={onMasterGainCommit}
                  onResizeSong={onResizeSong}
                  onMoveSong={onMoveSong}
                  runAction={runAction}
                  setStatus={setStatus}
                  onSnapshotApplied={onSnapshotApplied}
                  onSelectedRegionTransposeChange={onSelectedRegionTransposeChange}
                  onSelectedRegionWarpToggle={onSelectedRegionWarpToggle}
                  onSelectedRegionTempoChange={onSelectedRegionTempoChange}
                  onOpenInDaw={() => onOpenInDaw(shownRegion.id)}
                  onTapTempo={() => {
                    // Taps set the tempo at the playhead: bring it into this
                    // song first, or another song's tempo would change.
                    const position = performance.positionSecondsRef.current;
                    if (position < shownRegion.startSeconds || position >= shownRegion.endSeconds) {
                      performance.onSeek(shownRegion.startSeconds);
                    }
                    onTapTempo();
                  }}
                  workspaceEndSeconds={workspaceEndSeconds}
                />
              ) : null,
            },
            {
              mode: "sections",
              icon: "view_week",
              labelKey: "setlistView.edit.modes.sections",
              content: shownRegion ? (
                <SetlistSectionsPanel
                  song={performance.song}
                  region={shownRegion}
                  handlers={sectionHandlers}
                  layout={layout}
                />
              ) : null,
            },
            {
              mode: "arrangement",
              icon: "account_tree",
              labelKey: "setlistView.edit.modes.arrangement",
              content: shownRegion ? (
                <SetlistArrangementToolbar
                  region={shownRegion}
                  handlers={structureHandlers}
                  layout={layout}
                />
              ) : null,
            },
            {
              mode: "tracks",
              icon: "queue_music",
              labelKey: "setlistView.edit.modes.tracks",
              content:
                layout === "short" ? (
                  trackList
                ) : (
                  <p className="lt-setlist-sections-hint">{t("setlistView.tracks.hint")}</p>
                ),
            },
            ...waveformEditModes({
              song: performance.song,
              region: shownRegion,
              tracks,
              layout,
              menus,
              positionSecondsRef: performance.positionSecondsRef,
              waveformSummaries,
              onSeek: performance.onSeek,
              runShortcutAction,
              video: videoLanes,
            }),
            ...(FEATURE_FLAGS.lyrics
              ? [
                  {
                    mode: "lyrics" as const,
                    icon: "lyrics",
                    labelKey: "setlistView.edit.modes.lyrics",
                    content: (
                      <SetlistLyrics
                        performance={performance}
                        region={shownRegion}
                        onClose={() => void requestEditMode(null)}
                        startEditing
                      />
                    ),
                  },
                ]
              : []),
            ...(layout === "short"
              ? []
              : [
            {
              mode: "lanes" as const,
              icon: "view_timeline",
              labelKey: "setlistView.edit.modes.lanes",
              content: <p className="lt-setlist-sections-hint">{t("setlistView.lanes.hint")}</p>,
            },
                ]),
          ]}
        />
      </Zone>
    ) : null;
  const midiStrip = useMemo(
    () => ({ onToggleEnabled: menus.toggleMidiTrackEnabled, onEditRoute: menus.openMidiRouteEditor }),
    [menus],
  );
  const mixerZoneRef = useRef<HTMLElement | null>(null);
  const mixerHeightPx = useSetlistStore((state) => state.mixerHeightPx);
  const beginMixerResize = useMixerResize(rootRef, mixerZoneRef);
  const songsZoneRef = useRef<HTMLElement | null>(null);
  const songsHeightPx = useSetlistStore((state) => state.songsHeightPx);
  const songsResize = useSongsRowResize(rootRef, songsZoneRef);
  const paneButtons = (
    <>
      {layout === "short" ? (
        <button
          type="button"
          // A way to the other view, not a state: it is never lit (lit, «Mix»
          // read as if the mixer were what you were looking at).
          className="lt-setlist-pane-toggle"
          title={t(shortPane === "song" ? "setlistView.pane.showMixerTitle" : "setlistView.pane.showSongTitle")}
          onClick={() => setShortPane(shortPane === "song" ? "mixer" : "song")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {shortPane === "song" ? "tune" : "graphic_eq"}
          </span>
          {t(shortPane === "song" ? "setlistView.pane.mixer" : "setlistView.pane.song")}
        </button>
      ) : null}
      {FEATURE_FLAGS.lyrics ? (
        <button
          type="button"
          className={`lt-setlist-pane-toggle${lyricsOpen || lyricsPane ? " is-active" : ""}`}
          aria-pressed={lyricsOpen || lyricsPane}
          title={t("setlistView.lyrics.toggleTitle")}
          onClick={() => {
            if (layout === "short") setShortPane(lyricsPane ? "mixer" : "lyrics");
            else setLyricsOpen(!lyricsOpenSetting);
          }}
        >
          <span className="material-symbols-outlined" aria-hidden="true">lyrics</span>
          {t("setlistView.lyrics.button")}
        </button>
      ) : null}
      <SetlistEditButton />
    </>
  );
  // Phone, waveform pane: Playback keeps the view buttons in a dock over the
  // bottom right of the waveform, folded away with an arrow.
  const waveDock = layout === "short" && shortPane === "song";
  // Phone, console pane: the same buttons head the console's rail. The song
  // row keeps them only off the phone, or beside the lyrics (no rail there).
  const railButtons = layout === "short" && shortPane === "mixer";
  const mixer = (
    <Zone name="mixer" zoneRef={mixerZoneRef} drop={songDrop}>
      {layout === "wide" ? (
        <div
          className="lt-setlist-mixer-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("setlistView.mixer.resize")}
          onPointerDown={beginMixerResize}
        />
      ) : null}
      {(editMode === "lanes" || editMode === "automation" || editMode === "midi" || editMode === "video") && layout !== "short" ? lanes : editMode === "tracks" && layout !== "short" ? trackList : (
      <SetlistMixer
        song={performance.song}
        region={shownRegion}
        layout={layout}
        tracks={tracks}
        audioRoutingOptions={audioRoutingOptions}
        mixerHandlers={mixerHandlers}
        onTrackContextMenu={onTrackContextMenu}
        selectedTrackIds={selectedTrackIds}
        onTrackSelect={onTrackSelect}
        onTrackDragStart={onTrackDragStart}
        collapsedFolders={collapsedFolders}
        onToggleFolder={onToggleFolder}
        onMasterGainChange={onMasterGainChange}
        onMasterGainCommit={onMasterGainCommit}
        appSettings={appSettings}
        auxHandlers={auxHandlers}
        onAddAudioToSong={onAddAudioToSong}
        onOpenScenes={menus.openMixScenes}
        midiStrip={midiStrip}
        viewButtons={railButtons ? paneButtons : undefined}
      />
      )}
    </Zone>
  );
  // The song band: waveform and section map; edit mode exposes section handles
  // and lets the waveform seek without changing normal Playback section taps.
  const overview = (
    <Zone name="overview" drop={songDrop}>
      {shownRegion ? (
        <>
          {editMode === "arrangement" ? (
            layout === "short" ? (
              <SetlistArrangementEditor
                region={shownRegion}
                handlers={structureHandlers}
                layout={layout}
                song={performance.song}
                waveformSummaries={waveformSummaries}
                menus={menus}
                positionSecondsRef={performance.positionSecondsRef}
                onSeek={seekInWaveEditor}
              />
            ) : (
              <OverviewZoom
                startSeconds={shownRegion.startSeconds}
                endSeconds={shownRegion.endSeconds}
                positionSecondsRef={performance.positionSecondsRef}
                onSeek={seekInWaveEditor}
                tapToSeek={false}
              >
                <SetlistArrangementEditor region={shownRegion} handlers={structureHandlers} layout={layout}
                  song={performance.song} waveformSummaries={waveformSummaries} menus={menus}
                  positionSecondsRef={performance.positionSecondsRef} onSeek={seekInWaveEditor} />
              </OverviewZoom>
            )
          ) : <OverviewZoom
            startSeconds={shownRegion.startSeconds}
            endSeconds={shownRegion.endSeconds}
            positionSecondsRef={performance.positionSecondsRef}
            onSeek={seekInWaveEditor}
            tapToSeek={editMode === "sections"}
            overlay={
                  <>
                  {waveDock ? <WaveDock>{paneButtons}</WaveDock> : null}
                  <SongMap
                    part="actions"
                    song={performance.song}
                    region={shownRegion}
                    layout={layout}
                    positionSecondsRef={performance.positionSecondsRef}
                    pendingMarkerId={performance.pendingMarkerId}
                    activeVamp={performance.activeVamp}
                    onMarkerAction={performance.onMarkerAction}
                    onCancelPendingJump={performance.onCancelPendingJump}
                    onCueSong={onCueSong}
                    onPlaySong={onPlaySong}
                    onSectionContextMenu={onSectionContextMenu}
                    editing={editMode !== null}
                    arrangementPicker={
                      editMode === null ? (
                        <SetlistArrangementPicker region={shownRegion} handlers={structureHandlers} />
                      ) : null
                    }
                  />
                  </>
            }
          >
              <SongOverviewStrip
                region={shownRegion}
                clips={performance.song.clips}
                sectionMarkers={performance.song.sectionMarkers}
                waveformSummaries={waveformSummaries}
                positionSecondsRef={performance.positionSecondsRef}
                layout={layout}
                onSeek={editMode === "sections" ? seekInWaveEditor : performance.onSeek}
                clickToSeek={editMode === "sections"}
                onContextMenuAt={sectionHandlers.openMenuAt}
                onDoubleClickAt={editMode !== null ? sectionHandlers.createAt : undefined}
              />
              <SongMap
                part="blocks"
                song={performance.song}
                region={shownRegion}
                layout={layout}
                positionSecondsRef={performance.positionSecondsRef}
                pendingMarkerId={performance.pendingMarkerId}
                activeVamp={performance.activeVamp}
                onMarkerAction={performance.onMarkerAction}
                onCancelPendingJump={performance.onCancelPendingJump}
                onCueSong={onCueSong}
                onPlaySong={onPlaySong}
                onSectionContextMenu={onSectionContextMenu}
                editing={editMode !== null}
                showBarRuler={editMode === "sections"}
                arrangementPicker={
                  editMode === null ? (
                    <SetlistArrangementPicker region={shownRegion} handlers={structureHandlers} />
                  ) : null
                }
              />
                {sectionLayer}
              </OverviewZoom>}
        </>
      ) : null}
    </Zone>
  );
  // The DAW's song menu, with «Open in the DAW» first (step 17).
  const openSongMenu = (event: ReactMouseEvent<HTMLElement>, regionId: string) => {
    const region = regions.find((candidate) => candidate.id === regionId);
    if (!region || !menus.songRegionContextMenu) {
      onSongContextMenu(event, regionId);
      return;
    }
    onSelectRegion(regionId);
    menus.openMenu(event, region.name, [
      { label: t("setlistView.daw.open"), onSelect: () => onOpenInDaw(regionId) },
      ...menus.songRegionContextMenu(region),
    ]);
  };
  const songs = (
    <Zone name="songs" zoneRef={songsZoneRef}>
      {layout === "wide" ? (
        <div
          className="lt-setlist-songs-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("setlistView.songs.resize")}
          title={t("setlistView.songs.resizeTitle")}
          onPointerDown={songsResize.begin}
          onDoubleClick={songsResize.reset}
        />
      ) : null}
      <SetlistSongRow
        layout={layout}
        regions={regions}
        selectedRegionId={selectedRegionId}
        activeRegionId={activeRegionId}
        pendingRegionId={pendingRegionId}
        bpmByRegion={bpmByRegion}
        positionSecondsRef={performance.positionSecondsRef}
        dragPreview={dragPreview}
        transitionMode={performance.settings.songTransitionMode}
        onTransitionModeChange={performance.onSongTransitionModeChange}
        vampBetweenSongs={performance.vampBetweenSongs}
        onVampBetweenSongsChange={performance.onVampBetweenSongsChange}
        onSelectRegion={onSelectRegion}
        onCueSong={onCueSong}
        onPlaySong={onPlaySong}
        onSongContextMenu={openSongMenu}
        onReorderSong={onReorderSong}
        onDropOsFilesIntoSong={onDropOsFilesIntoSong}
        onDropLibraryAssetsIntoSong={onDropLibraryAssetsIntoSong}
        onSnapshotApplied={onSnapshotApplied}
        onImportSongPackageFromDialog={onImportSongPackageFromDialog}
        onImportSongPackageFromOsFile={onImportSongPackageFromOsFile}
        editing={editMode !== null}
      />
      {/* Phone, waveform pane: these ride over the waveform instead. */}
      {waveDock || railButtons || lyricsPane ? null : paneButtons}
    </Zone>
  );
  const closeLyrics = () => (layout === "short" ? setShortPane("mixer") : setLyricsOpen(false));
  const lyrics = (
    <Zone name="lyrics">
      <SetlistLyrics performance={performance} region={shownRegion} onClose={closeLyrics} />
    </Zone>
  );

  return (
    <main
      ref={rootRef}
      className={`lt-setlist-view is-${layout}${editMode ? " is-editing" : ""}${waveEditing ? " is-wave-editing" : ""}${
        mixerCollapsed && layout === "medium" ? " is-mixer-collapsed" : ""
      }${lyricsOpen ? " has-lyrics" : ""}${layout === "wide" && songsHeightPx !== null ? " has-songs-height" : ""
      }${
        layout === "short" && shortPane === "mixer" && mixerExpanded && editMode === null ? " is-mixer-expanded" : ""
      }`}
      data-setlist-layout={layout}
      aria-label={t("setlistView.title")}
      style={
        layout === "wide"
          ? ({
              ...(mixerHeightPx !== null ? { [MIXER_HEIGHT_VAR]: `${mixerHeightPx}px` } : null),
              ...(songsHeightPx !== null ? { [SONGS_HEIGHT_VAR]: `${songsHeightPx}px` } : null),
            } as CSSProperties)
          : undefined
      }
    >
      {/* The section menu's «Position…» opens this; in the DAW it lives in
          MobileDawOverlays, which only renders there. */}
      <MarkerPositionEditor
        song={performance.song}
        workspaceEndSeconds={workspaceEndSeconds}
        onCommit={onCommitMarkerPosition}
      />
      {/* Playback's order: songs, the song's waveform, the console. On the
          phone, as Playback on an iPhone, the waveform and the console take
          turns under the songs. */}
      <>
          {/* Phone, console enlarged: the song row steps aside. */}
          {layout === "short" && shortPane === "mixer" && mixerExpanded && editMode === null ? null : songs}
          {/* Phone, lyrics pane: a rail of its own on the right, like the console's. */}
          {lyricsPane ? (
            <div className="lt-setlist-lyrics-pane">
              {lyrics}
              <div className="lt-setlist-view-rail" role="toolbar" aria-label={t("setlistView.pane.rail")}>
                {paneButtons}
              </div>
            </div>
          ) : null}
          {layout === "wide" && lyricsOpen ? (
            // wide: the lyrics beside the band, at its height (the user's
            // call for Live); the console stays below.
            <div className="lt-setlist-band-row">
              {overview}
              {lyrics}
            </div>
          ) : layout === "medium" && lyricsOpen ? (
            // medium: the lyrics take the band's place.
            lyrics
          ) : waveEditing || layout !== "short" || shortPane === "song" ? (
            overview
          ) : null}
          {!waveEditing && (layout !== "short" || shortPane === "mixer") ? <div className="lt-setlist-bottom">{mixer}</div> : null}
          {/* Full-height side panel next to the band and the console. */}
          {drawer}
      </>
    </main>
  );
}

export const SetlistView = memo(SetlistViewComponent);
