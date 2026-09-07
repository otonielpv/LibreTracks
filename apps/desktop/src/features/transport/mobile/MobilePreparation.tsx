import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createEmptySong,
  isMobileApp,
  pauseTransport,
  playTransport,
  stopTransport,
  redoAction,
  seekTransport,
  undoAction,
} from "../desktopApi";
import { useTransportStore } from "../store";
import { useSongStore } from "../songStore";
import { useTimelineUIStore, type ViewMode } from "../uiStore";
import { formatUserFacingError } from "../errors/formatTransportError";
import { BASE_PIXELS_PER_SECOND } from "../timeline/timelineMath";
import { MobileAudioPanel } from "./MobileAudioPanel";
import { MobileTracksPanel } from "./MobileTracksPanel";
import { MobileMarkersPanel } from "./MobileMarkersPanel";
import { MobileClipsPanel } from "./MobileClipsPanel";
import { MobileAutomationPanel } from "./MobileAutomationPanel";
import {
  playheadCameraX,
  readPreparationOpen,
  writePreparationOpen,
} from "./mobileViewport";
import type { MobilePreparationProps, MobileRun } from "./types";
import "./mobilePreparation.css";

const TABS = ["audio", "tracks", "markers", "clips", "automation"] as const;
type Tab = (typeof TABS)[number];

export function MobilePreparation(props: MobilePreparationProps) {
  // Native platform identity, not viewport width: resizing desktop never opts in.
  return isMobileApp ? <Preparation {...props} /> : null;
}

function Preparation(props: MobilePreparationProps) {
  const { t } = useTranslation();
  const song = useSongStore((state) => state.song);
  const view = useTimelineUIStore((state) => state.viewMode);
  const tool = useTimelineUIStore((state) => state.mobileTimelineTool);
  const [open, setOpen] = useState(readPreparationOpen);
  const [tab, setTab] = useState<Tab>("audio");
  const [regionId, setRegionId] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const region = song?.regions.find((item) => item.id === regionId);
  const effectiveRegionId = region?.id ?? "";

  useEffect(() => {
    const stage = root.current?.closest(".lt-main-stage");
    stage?.classList.toggle("is-mobile-preparing", open);
    const siblings = [...(stage?.children ?? [])].filter(
      (child) => child !== root.current,
    );
    if (open) siblings.forEach((child) => child.setAttribute("inert", ""));
    return () => {
      stage?.classList.remove("is-mobile-preparing");
      siblings.forEach((child) => child.removeAttribute("inert"));
    };
  }, [open, view]);

  const showPreparation = (next: boolean) => {
    setOpen(next);
    writePreparationOpen(next);
  };

  const run: MobileRun = async (work) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      props.onSnapshot(await work());
      await props.refreshSong({ includeWaveforms: false });
      return true;
    } catch (cause) {
      const key = cause instanceof Error ? cause.message : "";
      setError(
        ["invalid", "missingSelection", "selectionRequired"].includes(key)
          ? t(`mobilePreparation.${key}`)
          : formatUserFacingError(cause, t, song),
      );
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const showView = (next: ViewMode) => {
    showPreparation(false);
    useTimelineUIStore.getState().setViewMode(next);
  };
  // El monolito ya mide el ancho útil de lanes y el zoom de encuadre; medirlos
  // aquí desde el DOM daría el valor equivocado (ver `mobileViewport.ts`).
  const fit = () => {
    useTimelineUIStore.getState().setZoomLevel(props.fitZoomLevel);
    useTimelineUIStore.getState().setCameraX(0);
  };
  const focusCursor = () =>
    useTimelineUIStore
      .getState()
      .setCameraX(
        playheadCameraX(
          props.positionRef.current,
          useTimelineUIStore.getState().zoomLevel * BASE_PIXELS_PER_SECOND,
          props.laneViewportWidth,
        ),
      );

  return (
    <div
      className={`lt-mobile-preparation ${open ? "is-open" : ""}`}
      ref={root}
    >
      <nav className="lt-prep-view-nav" aria-label={t("mobilePreparation.prepare")}>
        <button
          type="button"
          aria-pressed={open}
          onClick={() => showPreparation(!open)}
        >
          {t("mobilePreparation.prepare")}
        </button>
        {(["daw", "compact", "live"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={!open && view === mode}
            onClick={() => showView(mode)}
          >
            {t(`mobilePreparation.${mode}`)}
          </button>
        ))}
      </nav>
      {!open && view === "daw" && (
        <div className="lt-prep-navigation-tools">
          <button
            type="button"
            aria-pressed={tool === "navigate"}
            onClick={() =>
              useTimelineUIStore
                .getState()
                .setMobileTimelineTool(tool === "navigate" ? "edit" : "navigate")
            }
          >
            {t(
              tool === "navigate"
                ? "mobilePreparation.navigate"
                : "mobilePreparation.editTimeline",
            )}
          </button>
          <button type="button" onClick={fit}>
            {t("mobilePreparation.fit")}
          </button>
          <button type="button" onClick={focusCursor}>
            {t("mobilePreparation.cursor")}
          </button>
          <span>
            {t(
              tool === "navigate"
                ? "mobilePreparation.navigationHint"
                : "mobilePreparation.editHint",
            )}
          </span>
        </div>
      )}
      {open && song && (
        <section
          className="lt-prep-surface"
          aria-label={t("mobilePreparation.title")}
        >
          <div className="lt-prep-topline">
            {!creating && (
              <>
                <label>
                  <select
                    aria-label={t("mobilePreparation.song")}
                    value={effectiveRegionId}
                    onChange={(event) => setRegionId(event.target.value)}
                  >
                    <option value="">{t("mobilePreparation.session")}</option>
                    {song.regions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={() => setCreating(true)}>
                  {t("mobilePreparation.newSong")}
                </button>
              </>
            )}
            {creating && (
              <form
                className="lt-prep-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  const previous = new Set(song.regions.map((item) => item.id));
                  if (!newName.trim()) return;
                  void run(() => createEmptySong(newName.trim())).then((ok) => {
                    if (!ok) return;
                    setNewName("");
                    setCreating(false);
                    setRegionId(
                      useSongStore
                        .getState()
                        .song?.regions.find((item) => !previous.has(item.id))
                        ?.id ?? "",
                    );
                    setTab("audio");
                  });
                }}
              >
                <input
                  aria-label={t("mobilePreparation.newSong")}
                  placeholder={t("mobilePreparation.newSong")}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  required
                />
                <button type="submit" disabled={busy}>
                  {t("mobilePreparation.create")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCreating(false)}
                >
                  {t("mobilePreparation.cancel")}
                </button>
              </form>
            )}
          </div>
          <nav className="lt-prep-tabs" aria-label={t("mobilePreparation.title")}>
            {TABS.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={tab === item}
                onClick={() => setTab(item)}
              >
                {t(`mobilePreparation.${item}`)}
              </button>
            ))}
          </nav>
          <div className="lt-prep-feedback" aria-live="polite">
            {busy && t("mobilePreparation.working")}
            {error && <span role="alert">{error}</span>}
          </div>
          <fieldset
            className="lt-prep-content"
            disabled={busy}
            key={`${song.id}:${effectiveRegionId}`}
          >
            {tab === "audio" && (
              <MobileAudioPanel
                song={song}
                regionId={effectiveRegionId}
                run={run}
                positionRef={props.positionRef}
                assets={props.assets}
                onImport={() => props.onImport({ placeAfterImport: false })}
                importing={props.importing}
                importMessage={props.importMessage}
              />
            )}
            {tab === "tracks" && (
              <MobileTracksPanel
                song={song}
                regionId={effectiveRegionId}
                run={run}
                positionRef={props.positionRef}
                routes={props.routes}
              />
            )}
            {tab === "markers" && (
              <MobileMarkersPanel
                song={song}
                regionId={effectiveRegionId}
                run={run}
                positionRef={props.positionRef}
                normalizeSeconds={props.normalizeSeconds}
              />
            )}
            {tab === "clips" && (
              <MobileClipsPanel
                song={song}
                regionId={effectiveRegionId}
                run={run}
                positionRef={props.positionRef}
              />
            )}
            {tab === "automation" && (
              <MobileAutomationPanel
                song={song}
                regionId={effectiveRegionId}
                run={run}
                positionRef={props.positionRef}
                onCreateCue={props.onCreateCue}
                onEditCue={props.onEditCue}
              />
            )}
          </fieldset>
          <footer className="lt-prep-footer">
            <IconAction
              label={t("mobilePreparation.play")}
              icon="play_pause"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  useTransportStore.getState().playback?.playbackState ===
                  "playing"
                    ? pauseTransport()
                    : playTransport(),
                )
              }
            />
            <IconAction
              label={t("mobilePreparation.stop")}
              icon="stop"
              disabled={busy}
              onClick={() => void run(stopTransport)}
            />
            {region && (
              <IconAction
                label={t("mobilePreparation.atStart")}
                icon="skip_previous"
                disabled={busy}
                onClick={() => void run(() => seekTransport(region.startSeconds))}
              />
            )}
            <IconAction
              label={t("mobilePreparation.undo")}
              icon="undo"
              disabled={busy}
              onClick={() => void run(undoAction)}
            />
            <IconAction
              label={t("mobilePreparation.redo")}
              icon="redo"
              disabled={busy}
              onClick={() => void run(redoAction)}
            />
            <IconAction
              label={t("mobilePreparation.save")}
              icon="save"
              disabled={busy}
              onClick={props.onSave}
            />
            <IconAction
              label={t("mobilePreparation.library")}
              icon="library_music"
              onClick={props.onLibrary}
            />
            <IconAction
              label={t("mobilePreparation.settings")}
              icon="settings"
              onClick={props.onSettings}
            />
          </footer>
        </section>
      )}
    </div>
  );
}

function IconAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: string;
  disabled?: boolean;
  onClick: () => unknown;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true" className="material-symbols-outlined">
        {icon}
      </span>
    </button>
  );
}
