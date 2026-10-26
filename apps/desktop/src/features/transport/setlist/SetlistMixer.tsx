import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary, SongView } from "@libretracks/shared/models";
import {
  TRACK_FADER_SCALE,
  formatDb,
  gainToPosition,
  positionToDb,
  positionToGain,
  snapPositionToUnity,
} from "@libretracks/shared/faderScale";

import type { CompactMidiStripHandlers } from "../compact/CompactMidiStrip";
import { CompactMixer } from "../compact/CompactMixer";
import { PadManagerModal } from "../panels/PadManagerModal";
import { PadsControls, usePadsCatalog } from "../panels/PadsPopover";
import type { SongViewBindings } from "../songs/songViewBindings";
import { useTransportStore } from "../store";
import { SongMasterMeter } from "../tracks/TrackMeter";
import { SetlistConsoleStrip } from "./SetlistConsoleStrip";
import { useSetlistStore, type SetlistBottomTab } from "./setlistStore";
import { computeSongTrackContent } from "./songTrackContent";
import type { SetlistLayoutClass } from "./useSetlistLayout";

export type SetlistMixerProps = Pick<
  SongViewBindings,
  | "tracks"
  | "audioRoutingOptions"
  | "mixerHandlers"
  | "onTrackContextMenu"
  | "selectedTrackIds"
  | "onTrackSelect"
  | "onTrackDragStart"
  | "collapsedFolders"
  | "onToggleFolder"
  | "onMasterGainChange"
  | "onMasterGainCommit"
  | "appSettings"
  | "auxHandlers"
  | "onAddAudioToSong"
> & {
  /** The mix scenes manager (the DAW's MixSceneModal). */
  onOpenScenes: () => void;
  /** Phone: the view's own buttons (Waveform, Lyrics, Edit) at the top of
   * the rail, so the song row is all songs. */
  viewButtons?: ReactNode;
  /** MIDI tracks: on/off and routing, the DAW's commands. */
  midiStrip: CompactMidiStripHandlers;
  song: SongView;
  /** The song the console mixes (D4: the selected one). */
  region: SongRegionSummary | null;
  layout: SetlistLayoutClass;
};

const SHARED_TRACKS_HINT_KEY = "lt.setlistView.sharedTracksHintDismissed";
const MASTER_MAX_GAIN = 2;

function readHintDismissed() {
  try {
    return window.localStorage.getItem(SHARED_TRACKS_HINT_KEY) === "true";
  } catch {
    return false;
  }
}

function writeHintDismissed() {
  try {
    window.localStorage.setItem(SHARED_TRACKS_HINT_KEY, "true");
  } catch {
    // Blocked storage: the hint just shows again next time.
  }
}

const formatMaster = (position: number) =>
  `${formatDb(positionToDb(position, TRACK_FADER_SCALE))} dB`;

/** The pads panel, inline: same controls and manager as the DAW's popover. */
function SetlistPadsPanel({
  appSettings,
  audioRoutingOptions,
  auxHandlers,
}: Pick<SetlistMixerProps, "appSettings" | "audioRoutingOptions" | "auxHandlers">) {
  const { catalog, loadingCatalog, refreshCatalog } = usePadsCatalog();
  const [managerOpen, setManagerOpen] = useState(false);
  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);
  return (
    <div className="lt-setlist-mixer-panel is-pads lt-pads-controls-host">
      <PadsControls
        settings={appSettings}
        routeOptions={audioRoutingOptions}
        catalog={catalog}
        loadingCatalog={loadingCatalog}
        onToggleEnabled={auxHandlers.handlePadEnabledChange}
        onPadChange={auxHandlers.handlePadChange}
        onVolumeDraftChange={auxHandlers.handlePadVolumeDraftChange}
        onCommitVolume={auxHandlers.commitPadVolumeDraft}
        onOpenManager={() => setManagerOpen(true)}
        layout="panel"
      />
      <PadManagerModal
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        onCatalogChanged={refreshCatalog}
      />
    </div>
  );
}

/**
 * The Setlist console, Playback-style: the selected song's tracks across the
 * whole width and the song Master at the right end (the view's only master
 * fader outside Edit → Song). Click and voice guide stay in the top bar,
 * where the app already has them. Every control drives the DAW's own
 * handlers: the track strips are CompactMixer, the pads the body of the
 * DAW's pads popover, the master the region master-gain handlers.
 */
function SetlistMixerComponent({
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
  onAddAudioToSong,
  onOpenScenes,
  viewButtons,
  midiStrip,
  song,
  region,
  layout,
}: SetlistMixerProps) {
  const { t } = useTranslation();
  const bottomTab = useSetlistStore((state) => state.bottomTab);
  const setBottomTab = useSetlistStore((state) => state.setBottomTab);
  const collapsed = useSetlistStore((state) => state.mixerCollapsed);
  const expanded = useSetlistStore((state) => state.mixerExpanded);
  const setExpanded = useSetlistStore((state) => state.setMixerExpanded);
  const setCollapsed = useSetlistStore((state) => state.setMixerCollapsed);
  const [showAllTracks, setShowAllTracks] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  const optimisticMaster = useTransportStore((state) =>
    region ? state.optimisticRegionMaster[region.id] : undefined,
  );

  const songTrackIds = useMemo(
    () => (region ? computeSongTrackContent(song, region).trackIds : null),
    // The content only depends on the clip lists and the song's bounds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [song.clips, song.midiClips, song.videoClips, region?.startSeconds, region?.endSeconds],
  );
  const masterGain = optimisticMaster ?? region?.master?.gain ?? 1;
  const masterStrip = region ? (
    <SetlistConsoleStrip
      name={t("setlistView.mixer.master")}
      title={t("setlistView.mixer.masterTitle")}
      position={gainToPosition(masterGain, TRACK_FADER_SCALE)}
      ariaLabel={t("setlistView.mixer.masterAria", { name: region.name })}
      formatValue={formatMaster}
      onChange={(position) =>
        onMasterGainChange(
          region.id,
          Math.min(
            MASTER_MAX_GAIN,
            positionToGain(snapPositionToUnity(position, TRACK_FADER_SCALE, false), TRACK_FADER_SCALE),
          ),
        )
      }
      onCommit={() => onMasterGainCommit(region.id)}
      onDoubleClick={() => {
        onMasterGainChange(region.id, 1);
        onMasterGainCommit(region.id);
      }}
      meter={<SongMasterMeter regionId={region.id} orientation="vertical" />}
    />
  ) : null;

  const tabs: Array<{ tab: SetlistBottomTab; label: string; icon: string }> = [
    { tab: "tracks", label: t("setlistView.mixer.tabs.tracks"), icon: "equalizer" },
    { tab: "pads", label: t("setlistView.mixer.tabs.pads"), icon: "piano" },
  ];
  const tab: SetlistBottomTab = bottomTab;
  // Medium folds the console to its Master bar to give the waveform the
  // height; wide resizes it, and the phone swaps it with the waveform.
  const foldable = layout === "medium";
  // Phone: the header is a rail of icons on the right. Each one carries a
  // short word under it (the iPhone report: bare icons said nothing), and the
  // rail is the same in both tabs; a track action from Pads goes back to
  // Tracks first, so nothing hides (the same report).
  const short = layout === "short";
  const railLabel = (key: string) =>
    short ? <span className="lt-setlist-rail-label">{t(key)}</span> : null;
  const tracksAction = (action: () => void) => () => {
    if (tab !== "tracks") setBottomTab("tracks");
    action();
  };

  if (foldable && collapsed) {
    return (
      <div className={`lt-setlist-mixer is-${layout} is-collapsed`}>
        <div className="lt-setlist-console is-bar">{masterStrip}</div>
        <button
          type="button"
          className="lt-setlist-mixer-fold"
          aria-expanded={false}
          aria-label={t("setlistView.mixer.expand")}
          title={t("setlistView.mixer.expand")}
          onClick={() => setCollapsed(false)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">expand_less</span>
        </button>
      </div>
    );
  }

  return (
    <div className={`lt-setlist-mixer is-${layout}`}>
      <div className="lt-setlist-mixer-header">
        {viewButtons ? (
          <>
            {viewButtons}
            <span className="lt-setlist-rail-divider" aria-hidden="true" />
          </>
        ) : null}
        <div className="lt-setlist-mixer-tabs" role="tablist" aria-label={t("setlistView.mixer.label")}>
          {tabs.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              aria-selected={tab === entry.tab}
              className={`lt-setlist-tab${tab === entry.tab ? " is-active" : ""}`}
              title={entry.label}
              onClick={() => setBottomTab(entry.tab)}
            >
              {short ? (
                <span className="material-symbols-outlined" aria-hidden="true">{entry.icon}</span>
              ) : null}
              <span className={short ? "lt-setlist-rail-label" : "lt-setlist-mixer-action-label"}>{entry.label}</span>
            </button>
          ))}
        </div>
        {short ? <span className="lt-setlist-rail-divider" aria-hidden="true" /> : null}
        {(tab === "tracks" || short) && region ? (
          <button
            type="button"
            className="lt-setlist-mixer-action"
            title={t("setlistView.mixer.addAudioTitle")}
            aria-label={t("setlistView.tracks.addAudio")}
            onClick={tracksAction(() => onAddAudioToSong(region.id))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">library_music</span>
            <span className="lt-setlist-mixer-action-label">{t("setlistView.tracks.addAudio")}</span>
            {railLabel("setlistView.mixer.rail.audio")}
          </button>
        ) : null}
        {tab === "tracks" || short ? (
          <button
            type="button"
            // The compact view's track filter: same funnel, on = only this
            // song's tracks (the default), off = every track in the session.
            className={`lt-setlist-mixer-action${!showAllTracks ? " is-active" : ""}`}
            aria-pressed={!showAllTracks}
            aria-label={t("setlistView.mixer.filter")}
            title={t(showAllTracks ? "timelineToolbar.mixerFilterOff" : "timelineToolbar.mixerFilterOn")}
            onClick={tracksAction(() => setShowAllTracks((value) => !value))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {showAllTracks ? "filter_alt_off" : "filter_alt"}
            </span>
            <span className="lt-setlist-mixer-action-label">{t("setlistView.mixer.filter")}</span>
            {railLabel("setlistView.mixer.rail.filter")}
          </button>
        ) : null}
        {tab === "tracks" || short ? (
          <button
            type="button"
            className="lt-setlist-mixer-action"
            aria-label={t("setlistView.mixer.scenes")}
            title={t("setlistView.automation.scenesTitle")}
            onClick={onOpenScenes}
          >
            <span className="material-symbols-outlined" aria-hidden="true">bookmarks</span>
            <span className="lt-setlist-mixer-action-label">{t("setlistView.mixer.scenes")}</span>
            {railLabel("setlistView.mixer.scenes")}
          </button>
        ) : null}
        {layout === "short" ? (
          <button
            type="button"
            className={`lt-setlist-mixer-action${expanded ? " is-active" : ""}`}
            aria-pressed={expanded}
            aria-label={t(expanded ? "setlistView.mixer.shrink" : "setlistView.mixer.enlarge")}
            title={t(expanded ? "setlistView.mixer.shrink" : "setlistView.mixer.enlarge")}
            onClick={() => setExpanded(!expanded)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {expanded ? "close_fullscreen" : "open_in_full"}
            </span>
            {railLabel(expanded ? "setlistView.mixer.rail.shrink" : "setlistView.mixer.rail.enlarge")}
          </button>
        ) : null}
        {foldable ? (
          <button
            type="button"
            className="lt-setlist-mixer-fold"
            aria-expanded
            aria-label={t("setlistView.mixer.collapse")}
            title={t("setlistView.mixer.collapse")}
            onClick={() => setCollapsed(true)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
          </button>
        ) : null}
      </div>
      <div className="lt-setlist-mixer-body">
      {!hintDismissed && tab === "tracks" && layout !== "short" ? (
        <p className="lt-setlist-mixer-hint" role="note">
          <span>{t("setlistView.mixer.sharedTracksHint")}</span>
          <button
            type="button"
            className="lt-setlist-mixer-action"
            onClick={() => {
              writeHintDismissed();
              setHintDismissed(true);
            }}
          >
            {t("setlistView.mixer.gotIt")}
          </button>
        </p>
      ) : null}
      {tab === "tracks" && songTrackIds?.size === 0 && !showAllTracks ? (
        <p className="lt-setlist-mixer-empty">{t("setlistView.mixer.emptySong")}</p>
      ) : null}
      {tab === "tracks" ? (
        <div className="lt-setlist-console">
          <div className="lt-setlist-console-tracks">
            <CompactMixer
              tracks={tracks}
              audioRoutingOptions={audioRoutingOptions}
              handlers={mixerHandlers}
              onTrackContextMenu={onTrackContextMenu}
              selectedTrackIds={selectedTrackIds}
              onTrackSelect={onTrackSelect}
              onTrackDragStart={onTrackDragStart}
              activeSongTrackIds={songTrackIds}
              filterActiveSong={!showAllTracks}
              collapsedFolders={collapsedFolders}
              onToggleFolder={onToggleFolder}
              midiStrip={midiStrip}
            />
          </div>
          {masterStrip}
        </div>
      ) : null}
      {tab === "pads" ? (
        <SetlistPadsPanel
          appSettings={appSettings}
          audioRoutingOptions={audioRoutingOptions}
          auxHandlers={auxHandlers}
        />
      ) : null}
      </div>
    </div>
  );
}

export const SetlistMixer = memo(SetlistMixerComponent);
