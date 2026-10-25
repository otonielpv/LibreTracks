import { memo, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

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
import { resolveSetlistSongId } from "./songMapModel";
import { useSetlistStore, type SetlistShortTab } from "./setlistStore";
import { useSetlistLayout, type SetlistLayoutClass } from "./useSetlistLayout";
import "./setlist.css";

export type SetlistZone = "songs" | "map" | "overview" | "mixer" | "drawer";

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
};

/** A named, empty slot the later steps fill without stepping on each other. */
function Zone({
  name,
  children,
  zoneRef,
}: {
  name: SetlistZone;
  children?: ReactNode;
  zoneRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <section ref={zoneRef} className={`lt-setlist-zone is-${name}`} data-setlist-zone={name}>
      {children}
    </section>
  );
}

const SHORT_TABS: Array<{ tab: SetlistShortTab; labelKey: string }> = [
  { tab: "song", labelKey: "setlistView.tabs.song" },
  { tab: "mix", labelKey: "setlistView.tabs.mix" },
  { tab: "pads", labelKey: "setlistView.tabs.pads" },
];

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
  metronomeVolumeDraft,
  onMetronomeOutputChange,
  midiLearnMode,
  onMidiLearnTarget,
  multiTrackMix,
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
}: SetlistViewProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement | null>(null);
  const layout = useSetlistLayout(rootRef, layoutClass);
  const editMode = useSetlistStore((state) => state.editMode);
  const shortTab = useSetlistStore((state) => state.shortTab);
  const setShortTab = useSetlistStore((state) => state.setShortTab);
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
  const drawer = editMode !== null ? <Zone name="drawer" /> : null;
  const mixerZoneRef = useRef<HTMLElement | null>(null);
  const mixerHeightPx = useSetlistStore((state) => state.mixerHeightPx);
  const beginMixerResize = useMixerResize(rootRef, mixerZoneRef);
  const mixer = (padsOnly: boolean) => (
    <Zone name="mixer" zoneRef={mixerZoneRef}>
      {layout === "wide" ? (
        <div
          className="lt-setlist-mixer-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("setlistView.mixer.resize")}
          onPointerDown={beginMixerResize}
        />
      ) : null}
      <SetlistMixer
        song={performance.song}
        region={shownRegion}
        layout={layout}
        padsOnly={padsOnly}
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
        metronomeVolumeDraft={metronomeVolumeDraft}
        onMetronomeOutputChange={onMetronomeOutputChange}
        midiLearnMode={midiLearnMode}
        onMidiLearnTarget={onMidiLearnTarget}
        multiTrackMix={multiTrackMix}
      />
    </Zone>
  );
  const overview = (
    <Zone name="overview">
      {shownRegion ? (
        <SongOverviewStrip
          region={shownRegion}
          clips={performance.song.clips}
          sectionMarkers={performance.song.sectionMarkers}
          waveformSummaries={waveformSummaries}
          positionSecondsRef={performance.positionSecondsRef}
          layout={layout}
          onSeek={editMode === null ? performance.onSeek : undefined}
        />
      ) : null}
    </Zone>
  );
  const map = (
    <Zone name="map">
      {shownRegion ? (
        <SongMap
          song={performance.song}
          region={shownRegion}
          layout={layout}
          positionSecondsRef={performance.positionSecondsRef}
          pendingMarkerId={performance.pendingMarkerId}
          activeVamp={performance.activeVamp}
          onMarkerAction={performance.onMarkerAction}
          onCancelPendingJump={performance.onCancelPendingJump}
          onToggleVamp={performance.onToggleVamp}
          onCueSong={onCueSong}
          onPlaySong={onPlaySong}
          onSectionContextMenu={onSectionContextMenu}
        />
      ) : null}
    </Zone>
  );
  const songs = (
    <Zone name="songs">
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
        onSongContextMenu={onSongContextMenu}
        onReorderSong={onReorderSong}
        onDropOsFilesIntoSong={onDropOsFilesIntoSong}
        onDropLibraryAssetsIntoSong={onDropLibraryAssetsIntoSong}
        onSnapshotApplied={onSnapshotApplied}
        onImportSongPackageFromDialog={onImportSongPackageFromDialog}
        onImportSongPackageFromOsFile={onImportSongPackageFromOsFile}
      />
    </Zone>
  );

  return (
    <main
      ref={rootRef}
      className={`lt-setlist-view is-${layout}${editMode ? " is-editing" : ""}`}
      data-setlist-layout={layout}
      aria-label={t("setlistView.title")}
      style={
        layout === "wide" && mixerHeightPx !== null
          ? ({ [MIXER_HEIGHT_VAR]: `${mixerHeightPx}px` } as CSSProperties)
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
      {layout === "short" ? (
        <>
          {songs}
          <div className="lt-setlist-short-main">
            <div
              className="lt-setlist-tabs"
              role="tablist"
              aria-label={t("setlistView.tabs.label")}
            >
              {SHORT_TABS.map(({ tab, labelKey }) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  className={`lt-setlist-tab${shortTab === tab ? " is-active" : ""}`}
                  aria-selected={shortTab === tab}
                  onClick={() => setShortTab(tab)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            {shortTab === "song" ? (
              <div className="lt-setlist-song-band">
                {map}
                {overview}
              </div>
            ) : (
              mixer(shortTab === "pads")
            )}
          </div>
          {drawer}
        </>
      ) : (
        <>
          {songs}
          <div className="lt-setlist-song-band">
            {map}
            {overview}
          </div>
          <div className="lt-setlist-bottom">
            {mixer(false)}
            {drawer}
          </div>
        </>
      )}
    </main>
  );
}

export const SetlistView = memo(SetlistViewComponent);
