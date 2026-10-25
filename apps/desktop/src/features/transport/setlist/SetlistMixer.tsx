import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SongRegionSummary, SongView } from "@libretracks/shared/models";
import {
  AUX_FADER_SCALE,
  TRACK_FADER_SCALE,
  formatDb,
  formatGainDb,
  gainToPosition,
  positionToDb,
  positionToGain,
  snapPositionToUnity,
} from "@libretracks/shared/faderScale";

import { CompactMixer } from "../compact/CompactMixer";
import { MetronomeControls } from "../panels/MetronomePopover";
import { PadManagerModal } from "../panels/PadManagerModal";
import { PadsControls, usePadsCatalog } from "../panels/PadsPopover";
import { VoiceGuideControls } from "../panels/VoiceGuidePopover";
import type { SongViewBindings } from "../songs/songViewBindings";
import { useTransportStore } from "../store";
import { SongMasterMeter } from "../tracks/TrackMeter";
import { MultiTrackMixControls } from "../tracks/MultiTrackMixControls";
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
  | "metronomeVolumeDraft"
  | "onMetronomeOutputChange"
  | "midiLearnMode"
  | "onMidiLearnTarget"
  | "multiTrackMix"
> & {
  song: SongView;
  /** The song the console mixes (D4: the selected one). */
  region: SongRegionSummary | null;
  layout: SetlistLayoutClass;
  /** `short`: the right column's own «Pads» tab shows only the pads. */
  padsOnly?: boolean;
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

const formatAux = (position: number) => `${formatGainDb(positionToGain(position, AUX_FADER_SCALE))} dB`;
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
 * The Setlist console, Playback-style: the selected song's tracks, then
 * Click, Guide and the song Master at the right end (the view's only master
 * fader outside Edit → Song). Every control drives the DAW's own handlers:
 * the track strips are CompactMixer, Click/Guide/Pads the bodies of the DAW
 * popovers, the master the region master-gain handlers.
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
  metronomeVolumeDraft,
  onMetronomeOutputChange,
  midiLearnMode,
  onMidiLearnTarget,
  multiTrackMix,
  song,
  region,
  layout,
  padsOnly = false,
}: SetlistMixerProps) {
  const { t } = useTranslation();
  const bottomTab = useSetlistStore((state) => state.bottomTab);
  const setBottomTab = useSetlistStore((state) => state.setBottomTab);
  const collapsed = useSetlistStore((state) => state.mixerCollapsed);
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
  const selectedTracks = useMemo(() => {
    if (selectedTrackIds.length < 2) return [];
    const byId = new Map(tracks.map((track) => [track.id, track]));
    return selectedTrackIds
      .map((id) => byId.get(id))
      .filter((track): track is NonNullable<typeof track> => Boolean(track));
  }, [selectedTrackIds, tracks]);

  if (padsOnly) {
    return (
      <div className={`lt-setlist-mixer is-${layout}`}>
        <SetlistPadsPanel
          appSettings={appSettings}
          audioRoutingOptions={audioRoutingOptions}
          auxHandlers={auxHandlers}
        />
      </div>
    );
  }

  const masterGain = optimisticMaster ?? region?.master?.gain ?? 1;
  const clickStrip = (
    <SetlistConsoleStrip
      name={t("setlistView.mixer.click")}
      position={gainToPosition(metronomeVolumeDraft, AUX_FADER_SCALE)}
      ariaLabel={t("transport.settingsModal.metronomeVolume")}
      formatValue={formatAux}
      onChange={(position) =>
        auxHandlers.handleMetronomeVolumeDraftChange(positionToGain(position, AUX_FADER_SCALE))
      }
      onCommit={() => auxHandlers.commitMetronomeVolumeDraft(metronomeVolumeDraft)}
      onDoubleClick={() => auxHandlers.commitMetronomeVolumeDraft(1)}
      toggles={
        <>
          <button
            type="button"
            className={`lt-setlist-console-toggle${appSettings.metronomeEnabled ? " is-active" : ""}`}
            aria-pressed={appSettings.metronomeEnabled}
            aria-label={t("setlistView.mixer.clickToggle")}
            onClick={() => auxHandlers.handleMetronomeEnabledChange(!appSettings.metronomeEnabled)}
          >
            {t("setlistView.mixer.on")}
          </button>
          <button
            type="button"
            className="lt-setlist-console-toggle"
            aria-label={t("setlistView.mixer.clickSettings")}
            onClick={() => setBottomTab("click")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">tune</span>
          </button>
        </>
      }
    />
  );
  const guideStrip = (
    <SetlistConsoleStrip
      name={t("setlistView.mixer.guide")}
      position={gainToPosition(appSettings.voiceGuideVolume, AUX_FADER_SCALE)}
      ariaLabel={t("transport.settingsModal.voiceGuideVolume", { defaultValue: "Volumen" })}
      formatValue={formatAux}
      onChange={(position) =>
        auxHandlers.handleVoiceGuideVolumeDraftChange(positionToGain(position, AUX_FADER_SCALE))
      }
      onCommit={() => auxHandlers.commitVoiceGuideVolumeDraft(appSettings.voiceGuideVolume)}
      onDoubleClick={() => auxHandlers.commitVoiceGuideVolumeDraft(1)}
      toggles={
        <>
          <button
            type="button"
            className={`lt-setlist-console-toggle${appSettings.voiceGuideEnabled ? " is-active" : ""}`}
            aria-pressed={appSettings.voiceGuideEnabled}
            aria-label={t("setlistView.mixer.guideToggle")}
            onClick={() => auxHandlers.handleVoiceGuideEnabledChange(!appSettings.voiceGuideEnabled)}
          >
            {t("setlistView.mixer.on")}
          </button>
          <button
            type="button"
            className="lt-setlist-console-toggle"
            aria-label={t("setlistView.mixer.guideSettings")}
            onClick={() => setBottomTab("click")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">tune</span>
          </button>
        </>
      }
    />
  );
  const masterStrip = region ? (
    <SetlistConsoleStrip
      variant="master"
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
      meter={<SongMasterMeter regionId={region.id} className="lt-setlist-console-meter" />}
    />
  ) : null;

  const tabs: Array<{ tab: SetlistBottomTab; label: string }> = [
    { tab: "tracks", label: t("setlistView.mixer.tabs.tracks") },
    { tab: "click", label: t("setlistView.mixer.tabs.click") },
    ...(layout === "short" ? [] : [{ tab: "pads" as const, label: t("setlistView.mixer.tabs.pads") }]),
  ];
  const tab: SetlistBottomTab = layout === "short" && bottomTab === "pads" ? "tracks" : bottomTab;

  if (layout === "medium" && collapsed) {
    return (
      <div className={`lt-setlist-mixer is-${layout} is-collapsed`}>
        <div className="lt-setlist-console is-bar">
          {clickStrip}
          {guideStrip}
          {masterStrip}
        </div>
        <button
          type="button"
          className="lt-setlist-mixer-fold"
          aria-expanded={false}
          aria-label={t("setlistView.mixer.expand")}
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
        <div className="lt-setlist-mixer-tabs" role="tablist" aria-label={t("setlistView.mixer.label")}>
          {tabs.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              aria-selected={tab === entry.tab}
              className={`lt-setlist-tab${tab === entry.tab ? " is-active" : ""}`}
              onClick={() => setBottomTab(entry.tab)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {tab === "tracks" ? (
          <button
            type="button"
            className={`lt-setlist-mixer-action${showAllTracks ? " is-active" : ""}`}
            aria-pressed={showAllTracks}
            onClick={() => setShowAllTracks((value) => !value)}
          >
            {t("setlistView.mixer.allTracks")}
          </button>
        ) : null}
        {/* Mix scenes arrive with automation (step 12). */}
        <button type="button" className="lt-setlist-mixer-action" hidden>
          {t("setlistView.mixer.scenes")}
        </button>
        {layout === "medium" ? (
          <button
            type="button"
            className="lt-setlist-mixer-fold"
            aria-expanded
            aria-label={t("setlistView.mixer.collapse")}
            onClick={() => setCollapsed(true)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">expand_more</span>
          </button>
        ) : null}
      </div>
      {!hintDismissed && tab === "tracks" ? (
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
      {tab === "tracks" && selectedTracks.length > 1 ? (
        <div className="lt-setlist-mixer-selection lt-mobile-selection-mix">
          <MultiTrackMixControls
            tracks={selectedTracks}
            routingOptions={audioRoutingOptions}
            mix={multiTrackMix}
          />
        </div>
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
            />
          </div>
          <div className="lt-setlist-console-aux">
            {clickStrip}
            {guideStrip}
          </div>
          {masterStrip}
        </div>
      ) : null}
      {tab === "click" ? (
        <div className="lt-setlist-mixer-panel is-click">
          <section className="lt-pads-controls-host">
            <MetronomeControls
              settings={appSettings}
              routeOptions={audioRoutingOptions}
              volumeDraft={metronomeVolumeDraft}
              midiLearnMode={midiLearnMode}
              onEnabledChange={auxHandlers.handleMetronomeEnabledChange}
              onOutputChange={onMetronomeOutputChange}
              onVolumeDraftChange={auxHandlers.handleMetronomeVolumeDraftChange}
              onCommitVolume={auxHandlers.commitMetronomeVolumeDraft}
              onSoundChange={auxHandlers.handleMetronomeSoundChange}
              onMidiLearnTarget={onMidiLearnTarget}
            />
          </section>
          <section className="lt-pads-controls-host">
            <VoiceGuideControls
              settings={appSettings}
              routeOptions={audioRoutingOptions}
              onChange={auxHandlers.handleVoiceGuideChange}
              onVolumeDraftChange={auxHandlers.handleVoiceGuideVolumeDraftChange}
              onCommitVolume={auxHandlers.commitVoiceGuideVolumeDraft}
            />
          </section>
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
  );
}

export const SetlistMixer = memo(SetlistMixerComponent);
