import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  leaveHost,
  roleAllows,
  sendGuestCommand,
  type NetworkGuestStatus,
  type NetworkLiveSettings,
} from "@libretracks/shared/networkApi";
import {
  MAX_CAPO,
  MAX_PERSONAL_TRANSPOSE,
  personalChordShift,
  type AccidentalPreference,
} from "@libretracks/shared/charts/personalChords";
import {
  DEFAULT_APP_SETTINGS,
  type ActiveVampSummary,
  type SongView,
} from "@libretracks/shared/models";

import { LivePerformanceView, type LiveViewSettings } from "../transport/live/LivePerformanceView";
import { createGuestCommandHandlers } from "./guestCommandHandlers";
import { GuestMixPanel } from "./GuestMixPanel";
import { guestPositionAt, regionAt, useGuestPlayheadRef } from "./guestPlayhead";
import { useNetworkSessionStore } from "./networkSessionStore";
import { usePersonalChords } from "./usePersonalChords";


/** The host's jump settings over the defaults: an older host, or one that
 * has not published yet, still gives the view every field it reads. */
function liveSettingsOf(settings: NetworkLiveSettings | null): LiveViewSettings {
  return { ...DEFAULT_APP_SETTINGS, ...(settings ?? {}) } as LiveViewSettings;
}

/**
 * What a network-session guest sees: the host's live view, with this
 * device's own way of reading chords. The guest's own session stays where it
 * was underneath and is not touched (plan rule 5).
 */
export function GuestLiveScreen() {
  const guest = useNetworkSessionStore((state) => state.guest);
  const song = useNetworkSessionStore((state) => state.guestSong);
  const transport = useNetworkSessionStore((state) => state.guestTransport);
  const liveSettings = useNetworkSessionStore((state) => state.guestLiveSettings);
  const positionRef = useGuestPlayheadRef(transport);

  return (
    <div className="lt-guest-screen" data-testid="guest-live-screen">
      <GuestLiveContent
        guest={guest}
        song={song}
        settings={liveSettingsOf(liveSettings)}
        positionRef={positionRef}
        anchorSeconds={guestPositionAt(transport, transport?.emittedAtUnixMs ?? 0)}
        pendingMarkerId={transport?.snapshot.pendingMarkerJump?.targetMarkerId ?? null}
        pendingMarkerName={transport?.snapshot.pendingMarkerJump?.targetMarkerName ?? null}
        activeVamp={transport?.snapshot.activeVamp ?? null}
        playbackState={transport?.snapshot.playbackState ?? null}
      />
    </div>
  );
}

type ContentProps = {
  guest: NetworkGuestStatus;
  song: SongView | null;
  settings: LiveViewSettings;
  positionRef: { readonly current: number };
  /** Position at the last transport update: enough to know which song is
   * on without re-rendering every frame. */
  anchorSeconds: number;
  pendingMarkerId: string | null;
  pendingMarkerName: string | null;
  activeVamp: ActiveVampSummary | null;
  playbackState: string | null;
};

function GuestLiveContent({
  guest,
  song,
  settings,
  positionRef,
  anchorSeconds,
  pendingMarkerId,
  pendingMarkerName,
  activeVamp,
  playbackState,
}: ContentProps) {
  const { t } = useTranslation();
  const openModal = useNetworkSessionStore((state) => state.openModal);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [mixOpen, setMixOpen] = useState(false);
  // The «host changed this song» question, as the resolver of a promise so
  // the edit flow reads straight (ask, then act).
  const [overwriteQuestion, setOverwriteQuestion] = useState<
    ((overwrite: boolean) => void) | null
  >(null);
  const errorText = (code: string) =>
    t(`networkSession.errors.${code}`, {
      defaultValue: t("networkSession.errors.generic", { detail: code }),
    });
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;
  useEffect(() => {
    if (!commandError) return;
    const timer = window.setTimeout(() => setCommandError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [commandError]);

  // Built once; reads the store through getters so it never goes stale.
  const handlers = useMemo(
    () =>
      createGuestCommandHandlers({
        send: sendGuestCommand,
        getRole: () => useNetworkSessionStore.getState().guest.role,
        getSettings: () => liveSettingsOf(useNetworkSessionStore.getState().guestLiveSettings),
        getSong: () => useNetworkSessionStore.getState().guestSong,
        getPlaybackState: () =>
          useNetworkSessionStore.getState().guestTransport?.snapshot.playbackState ?? null,
        getPendingMarkerId: () =>
          useNetworkSessionStore.getState().guestTransport?.snapshot.pendingMarkerJump
            ?.targetMarkerId ?? null,
        onError: setCommandError,
        confirmOverwrite: () =>
          new Promise<boolean>((resolve) => setOverwriteQuestion(() => resolve)),
        errorText: (code) => errorTextRef.current(code),
      }),
    [],
  );
  const canControl = guest.state === "connected" && roleAllows(guest.role, "play");
  const canEdit = guest.state === "connected" && roleAllows(guest.role, "setSongChart");
  const liveSettings = useNetworkSessionStore((state) => state.guestLiveSettings);
  const currentRegion = useMemo(() => regionAt(song, anchorSeconds), [song, anchorSeconds]);
  const chords = usePersonalChords(currentRegion?.id ?? null);
  const shift = personalChordShift(chords.prefs);

  const header = (
    <div className="lt-guest-header">
      <button
        type="button"
        className="lt-guest-leave"
        onClick={() => void leaveHost()}
        aria-label={t("networkSession.guest.leave")}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          logout
        </span>
        {t("networkSession.guest.leave")}
      </button>
      <button type="button" className="lt-guest-host" onClick={openModal}>
        <span className="material-symbols-outlined" aria-hidden="true">
          hub
        </span>
        <span>
          <strong>{guest.hostName || guest.address}</strong>
          <small>
            {guest.role ? t(`networkSession.roles.${guest.role}`) : ""}
            {guest.rttMs !== null
              ? ` · ${t("networkSession.latency", { ms: Math.round(guest.rttMs / 2) })}`
              : ""}
          </small>
        </span>
      </button>
      {canControl ? (
        <span className="lt-guest-transport" role="group" aria-label={t("networkSession.guest.transport")}>
          {playbackState === "playing" ? (
            <button type="button" aria-label={t("networkSession.guest.pause")} onClick={handlers.pause}>
              <span className="material-symbols-outlined" aria-hidden="true">pause</span>
            </button>
          ) : (
            <button type="button" aria-label={t("networkSession.guest.play")} onClick={handlers.play}>
              <span className="material-symbols-outlined" aria-hidden="true">play_arrow</span>
            </button>
          )}
          <button type="button" aria-label={t("networkSession.guest.stop")} onClick={handlers.stop}>
            <span className="material-symbols-outlined" aria-hidden="true">stop</span>
          </button>
        </span>
      ) : null}
      {canEdit ? (
        <button
          type="button"
          className={`lt-guest-leave${mixOpen ? " is-active" : ""}`}
          aria-pressed={mixOpen}
          onClick={() => setMixOpen((open) => !open)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            tune
          </span>
          {t("networkSession.mix.title")}
        </button>
      ) : null}
      {currentRegion ? (
        <div className="lt-guest-chords" role="group" aria-label={t("networkSession.guest.chords")}>
          <Stepper
            label={t("networkSession.guest.capo")}
            value={chords.prefs.capo}
            display={String(chords.prefs.capo)}
            min={0}
            max={MAX_CAPO}
            onChange={(capo) => chords.setPrefs({ ...chords.prefs, capo })}
          />
          <Stepper
            label={t("networkSession.guest.transpose")}
            value={chords.prefs.transpose}
            display={chords.prefs.transpose > 0 ? `+${chords.prefs.transpose}` : String(chords.prefs.transpose)}
            min={-MAX_PERSONAL_TRANSPOSE}
            max={MAX_PERSONAL_TRANSPOSE}
            onChange={(transpose) => chords.setPrefs({ ...chords.prefs, transpose })}
          />
          <select
            aria-label={t("networkSession.guest.accidentals")}
            value={chords.accidentals}
            onChange={(event) => chords.setAccidentals(event.target.value as AccidentalPreference)}
          >
            {(["auto", "sharps", "flats"] as AccidentalPreference[]).map((value) => (
              <option key={value} value={value}>
                {t(`networkSession.guest.accidental.${value}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      {guest.state === "lost" || guest.state === "connecting" ? (
        <div
          className={`lt-guest-banner${guest.state === "lost" ? " is-error" : ""}`}
          role="status"
        >
          {t(`networkSession.state.${guest.state}`)}
        </div>
      ) : null}
      {commandError ? (
        <div className="lt-guest-banner is-error" role="alert">
          {t(`networkSession.errors.${commandError}`, {
            defaultValue: t("networkSession.errors.generic", { detail: commandError }),
          })}
        </div>
      ) : null}
      {song ? (
        <LivePerformanceView
          song={song}
          positionSecondsRef={positionRef}
          settings={settings}
          pendingMarkerId={pendingMarkerId}
          pendingMarkerName={pendingMarkerName}
          activeVamp={activeVamp}
          headerStart={header}
          canControl={canControl}
          canEditChart={canEdit}
          chartExtraSemitones={shift}
          chartAccidentals={chords.accidentals}
          onMarkerAction={handlers.onMarkerAction}
          onSongAction={handlers.onSongAction}
          onReorderSong={canControl ? handlers.onReorderSong : undefined}
          onChartChange={handlers.onChartChange}
          onToggleVamp={handlers.onToggleVamp}
          onCancelPendingJump={handlers.onCancelPendingJump}
          onGlobalJumpModeChange={handlers.onGlobalJumpModeChange}
          onGlobalJumpBarsChange={handlers.onGlobalJumpBarsChange}
          onSongJumpTriggerChange={handlers.onSongJumpTriggerChange}
          onSongJumpBarsChange={handlers.onSongJumpBarsChange}
          onSongTransitionModeChange={handlers.onSongTransitionModeChange}
          onVampModeChange={handlers.onVampModeChange}
          onVampBarsChange={handlers.onVampBarsChange}
        />
      ) : (
        <div className="lt-guest-waiting">
          {header}
          <p>{t("networkSession.guest.waiting")}</p>
        </div>
      )}
      {canEdit && mixOpen && song ? (
        <GuestMixPanel
          song={song}
          region={currentRegion}
          metronomeEnabled={liveSettings?.metronomeEnabled ?? false}
          metronomeVolume={liveSettings?.metronomeVolume ?? 1}
          handlers={handlers}
          onClose={() => setMixOpen(false)}
        />
      ) : null}
      {overwriteQuestion ? (
        <div className="lt-modal-backdrop">
          <section className="lt-settings-modal" role="alertdialog" aria-modal="true">
            <div className="lt-settings-modal-body">
              <p>{t("networkSession.edit.staleQuestion")}</p>
              <div className="lt-network-actions">
                <button
                  type="button"
                  className="lt-network-button is-primary"
                  onClick={() => {
                    overwriteQuestion(true);
                    setOverwriteQuestion(null);
                  }}
                >
                  {t("networkSession.edit.overwrite")}
                </button>
                <button
                  type="button"
                  className="lt-network-button"
                  onClick={() => {
                    overwriteQuestion(false);
                    setOverwriteQuestion(null);
                  }}
                >
                  {t("networkSession.edit.keepEditing")}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function Stepper({
  label,
  value,
  display,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <span className="lt-guest-stepper">
      <span className="lt-guest-stepper-label">{label}</span>
      <button
        type="button"
        aria-label={`${label} −`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output aria-label={label}>{display}</output>
      <button
        type="button"
        aria-label={`${label} +`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  );
}
