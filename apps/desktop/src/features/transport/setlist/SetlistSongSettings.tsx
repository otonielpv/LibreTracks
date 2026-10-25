import { memo, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  SONG_KEY_OPTIONS,
  formatTransposeSemitones,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { formatClock, formatMusicalPosition } from "../helpers";
import type { TimelineMenus } from "../menus/timelineMenus";
import {
  musicalPositionToSeconds,
  parseMusicalPosition,
} from "../mobile/musicalPosition";
import { songCountStyleMenuActions } from "../songs/songCountStyle";
import { songFadeMenuActions } from "../songs/songFades";
import type { SongViewBindings } from "../songs/songViewBindings";
import { useTransportStore } from "../store";
import { requestStructureEdit } from "../structure/structureGuard";
import { RegionTempoControl } from "../timeline/RegionTempoControl";
import { clampRegionResizeEdge, regionResizeBounds } from "../timeline/regionResize";
import type { ContextMenuAction } from "../types";
import { barSecondsAtFor } from "./songMapModel";

type SetlistSongSettingsProps = { onOpenInDaw: () => void } & Pick<
  SongViewBindings,
  | "regions"
  | "bpmByRegion"
  | "appSettings"
  | "onSetSongKey"
  | "onMasterGainChange"
  | "onMasterGainCommit"
  | "onResizeSong"
  | "onMoveSong"
  | "runAction"
  | "setStatus"
  | "onSnapshotApplied"
  | "onSelectedRegionTransposeChange"
  | "onSelectedRegionWarpToggle"
  | "onSelectedRegionTempoChange"
  | "onTapTempo"
  | "workspaceEndSeconds"
> & {
  song: SongView;
  region: SongRegionSummary;
  menus: TimelineMenus;
};

/** The song menu's entry whose label is `label` (the menu is the canonical
 * implementation; the form shows its entries as buttons). */
function menuEntry(actions: readonly ContextMenuAction[], label: string) {
  return (
    actions.find((action) => action.label === label || action.label === `${label} ▸`) ?? null
  );
}

function ActionButton({ action, children }: { action: ContextMenuAction | null; children?: ReactNode }) {
  if (!action) return null;
  return (
    <button
      type="button"
      className="lt-setlist-settings-button"
      disabled={action.disabled}
      onClick={() => void action.onSelect()}
    >
      {children ?? action.label.replace(/ ▸$/, "")}
    </button>
  );
}

/** A labelled row: the label names the whole group of controls next to it
 * (screen readers announce it on entering any of them). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="lt-setlist-settings-field" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="lt-setlist-settings-label">
        {label}
      </span>
      <div className="lt-setlist-settings-control">{children}</div>
    </div>
  );
}

/** One card of the form, with its heading. */
function SettingsSection({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="lt-setlist-settings-section" aria-labelledby={headingId}>
      <h3 id={headingId} className="lt-setlist-settings-heading">
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** "1:05.250" → 65.25; plain seconds also accepted. `null` = not a time. */
export function parseClockInput(input: string): number | null {
  const trimmed = input.trim().replace(",", ".");
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length > 2) return null;
  const numbers = parts.map(Number);
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return parts.length === 2 ? numbers[0] * 60 + numbers[1] : numbers[0];
}

/** One edge of the song as bar.beat and as m:ss, committed on Enter/blur. */
function EdgeField({
  label,
  seconds,
  song,
  maxSeconds,
  onCommit,
}: {
  label: string;
  seconds: number;
  song: SongView;
  maxSeconds: number;
  onCommit: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const [bar, setBar] = useState(() => formatMusicalPosition(seconds, song));
  const [clock, setClock] = useState(() => formatClock(seconds));
  useEffect(() => {
    setBar(formatMusicalPosition(seconds, song));
    setClock(formatClock(seconds));
  }, [seconds, song]);

  const commitBar = () => {
    const parsed = parseMusicalPosition(bar);
    if (!parsed) return setBar(formatMusicalPosition(seconds, song));
    onCommit(musicalPositionToSeconds(parsed, song, maxSeconds));
  };
  const commitClock = () => {
    const parsed = parseClockInput(clock);
    if (parsed === null) return setClock(formatClock(seconds));
    onCommit(parsed);
  };
  return (
    <Field label={label}>
      <input
        className="lt-setlist-settings-input"
        value={bar}
        aria-label={`${label} · ${t("markerPosition.bar", { defaultValue: "Compás.tiempo" })}`}
        onChange={(event) => setBar(event.target.value)}
        onBlur={commitBar}
        onKeyDown={(event) => event.key === "Enter" && commitBar()}
      />
      <input
        className="lt-setlist-settings-input"
        value={clock}
        aria-label={`${label} · ${t("markerPosition.seconds", { defaultValue: "Segundos" })}`}
        onChange={(event) => setClock(event.target.value)}
        onBlur={commitClock}
        onKeyDown={(event) => event.key === "Enter" && commitClock()}
      />
    </Field>
  );
}

/**
 * Edit → Song: the selected song's settings as a form. Nothing here is a new
 * implementation. Rename, key changes, warp source BPM, export, render,
 * analyse and delete are the DAW song menu's own entries; fades and the count
 * style are its submenus' actions; transpose, warp and tempo are the
 * toolbar's selected-song handlers; edges and spacing are the DAW region
 * band's commits with its clamp rules (timeline/regionResize).
 */
function SetlistSongSettingsComponent({
  song,
  region,
  menus,
  regions,
  bpmByRegion,
  appSettings,
  onSetSongKey,
  onMasterGainChange,
  onMasterGainCommit,
  onResizeSong,
  onMoveSong,
  runAction,
  setStatus,
  onSnapshotApplied,
  onSelectedRegionTransposeChange,
  onSelectedRegionWarpToggle,
  onSelectedRegionTempoChange,
  onTapTempo,
  onOpenInDaw,
  workspaceEndSeconds,
}: SetlistSongSettingsProps) {
  const { t } = useTranslation();
  const optimisticMaster = useTransportStore((state) => state.optimisticRegionMaster[region.id]);
  const songMenu = menus.songRegionContextMenu?.(region) ?? [];
  const entry = (key: string) => menuEntry(songMenu, t(key));
  const actionDeps = {
    t,
    runAction,
    applyPlaybackSnapshot: (snapshot: Parameters<typeof onSnapshotApplied>[0] | null) => {
      if (snapshot) onSnapshotApplied(snapshot);
    },
    setStatus,
  };
  const fadeActions = songFadeMenuActions(region, actionDeps);
  const countStyleActions = songCountStyleMenuActions(region, {
    ...actionDeps,
    globalCountStyle: appSettings.voiceGuideCountStyle,
  });
  const currentBpm = bpmByRegion[region.id] ?? song.bpm;
  const masterGain = optimisticMaster ?? region.master?.gain ?? 1;

  const sorted = [...regions].sort((left, right) => left.startSeconds - right.startSeconds);
  const index = sorted.findIndex((candidate) => candidate.id === region.id);
  const previous = index > 0 ? sorted[index - 1] : null;
  const gapSeconds = previous ? region.startSeconds - previous.endSeconds : 0;
  const barSeconds = previous ? barSecondsAtFor(song)(previous.endSeconds) : 0;
  const gapBars = barSeconds > 0 ? Math.round((gapSeconds / barSeconds) * 100) / 100 : 0;
  const [gapDraft, setGapDraft] = useState(String(gapBars));
  useEffect(() => setGapDraft(String(gapBars)), [gapBars]);

  const commitEdge = (edge: "start" | "end", seconds: number) => {
    // Same walls as dragging the edge in the DAW, and the arrangement guard
    // before touching a song whose timeline is an applied arrangement.
    const bounds = regionResizeBounds(regions, region, song.clips, workspaceEndSeconds);
    const next = clampRegionResizeEdge(edge, seconds, bounds);
    const start = edge === "start" ? next : region.startSeconds;
    const end = edge === "end" ? next : region.endSeconds;
    if (start === region.startSeconds && end === region.endSeconds) return;
    if (!requestStructureEdit([region.startSeconds])) return;
    onResizeSong(region.id, start, end);
  };

  const commitGap = () => {
    const bars = Number(gapDraft.replace(",", "."));
    if (!previous || !Number.isFinite(bars) || barSeconds <= 0) {
      setGapDraft(String(gapBars));
      return;
    }
    // Like moving the song in the DAW: it can't slide into the previous one.
    const nextStart = Math.max(previous.endSeconds, previous.endSeconds + bars * barSeconds);
    const delta = nextStart - region.startSeconds;
    if (Math.abs(delta) > 1e-6) onMoveSong(region.id, delta);
  };

  return (
    <div className="lt-setlist-settings" aria-label={t("setlistView.edit.songSettings", { name: region.name })}>
      <section className="lt-setlist-settings-section is-plain">
        <div className="lt-setlist-settings-row">
          <ActionButton action={entry("transport.menu.renameSong")} />
          <button
            type="button"
            className="lt-setlist-settings-button"
            title={t("setlistView.daw.openTitle")}
            onClick={onOpenInDaw}
          >
            <span className="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            {t("setlistView.daw.open")}
          </button>
        </div>
      </section>

      <SettingsSection icon="music_note" title={t("setlistView.edit.keySection")}>
        <Field label={t("setlistView.edit.key")}>
          <select
            className="lt-setlist-settings-input"
            value={region.key ?? ""}
            aria-label={t("setlistView.edit.key")}
            onChange={(event) => onSetSongKey(region.id, event.target.value || null)}
          >
            <option value="">{t("transport.menu.songKeyNone", { defaultValue: "Sin nota" })}</option>
            {SONG_KEY_OPTIONS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("setlistView.edit.transpose")}>
          <button
            type="button"
            className="lt-setlist-settings-button"
            aria-label={t("timelineToolbar.regionTransposeDownAria")}
            title={t("timelineToolbar.regionTransposeDownAria")}
            onClick={() => onSelectedRegionTransposeChange(Math.max(-12, region.transposeSemitones - 1))}
          >
            −
          </button>
          <output className="lt-setlist-settings-value">{formatTransposeSemitones(region.transposeSemitones)}</output>
          <button
            type="button"
            className="lt-setlist-settings-button"
            aria-label={t("timelineToolbar.regionTransposeUpAria")}
            title={t("timelineToolbar.regionTransposeUpAria")}
            onClick={() => onSelectedRegionTransposeChange(Math.min(12, region.transposeSemitones + 1))}
          >
            +
          </button>
        </Field>
        <div className="lt-setlist-settings-row">
          <ActionButton action={entry("transport.keyChanges.addAtCursor")} />
        </div>
      </SettingsSection>

      <SettingsSection icon="speed" title={t("setlistView.edit.tempoSection")}>
        <Field label={t("setlistView.edit.warp")}>
          <button
            type="button"
            className={`lt-setlist-settings-button${region.warpEnabled ? " is-active" : ""}`}
            aria-pressed={region.warpEnabled}
            onClick={() => onSelectedRegionWarpToggle(!region.warpEnabled)}
          >
            {region.warpEnabled ? t("setlistView.edit.warpOn") : t("setlistView.edit.warpOff")}
          </button>
        </Field>
        <RegionTempoControl
          key={region.id}
          currentBpm={currentBpm}
          originalBpm={region.warpEnabled && region.warpSourceBpm ? region.warpSourceBpm : currentBpm}
          disabled={false}
          onChange={(bpm) => onSelectedRegionTempoChange(region, bpm)}
        />
        <div className="lt-setlist-settings-row">
          {/* The top bar's tap tempo: taps set the tempo in force at the
              playhead, which editing keeps inside this song. */}
          <button
            type="button"
            className="lt-setlist-settings-button lt-setlist-tap-tempo"
            title={t("setlistView.tempo.tapTitle")}
            onClick={onTapTempo}
          >
            <span className="material-symbols-outlined" aria-hidden="true">touch_app</span>
            {t("setlistView.tempo.tap")}
          </button>
          <ActionButton action={entry("transport.menu.changeRegionWarpSourceBpm")} />
        </div>
      </SettingsSection>

      <SettingsSection icon="volume_up" title={t("setlistView.edit.levelSection")}>
        <Field label={t("setlistView.mixer.master")}>
          <input
            type="range"
            className="lt-fader is-volume lt-setlist-master-fader"
            min={0}
            max={2}
            step={0.01}
            value={masterGain}
            title={t("setlistView.mixer.masterTitle")}
            aria-label={t("setlistView.mixer.masterAria", { name: region.name })}
            onChange={(event) => onMasterGainChange(region.id, Number(event.target.value) || 0)}
            onPointerUp={() => onMasterGainCommit(region.id)}
            onKeyUp={() => onMasterGainCommit(region.id)}
          />
        </Field>
        <div className="lt-setlist-settings-row">
          {fadeActions.map((action) => (
            <ActionButton key={action.label} action={action} />
          ))}
        </div>
        <Field label={t("transport.menu.songCountStyle")}>
          <div className="lt-setlist-settings-choices" role="radiogroup" aria-label={t("transport.menu.songCountStyle")}>
            {countStyleActions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="radio"
                aria-checked={Boolean(action.swatch)}
                className={`lt-setlist-settings-button${action.swatch ? " is-active" : ""}`}
                onClick={() => void action.onSelect()}
              >
                {action.label}
              </button>
            ))}
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection icon="straighten" title={t("setlistView.edit.boundsSection")}>
        <EdgeField
          label={t("setlistView.edit.start")}
          seconds={region.startSeconds}
          song={song}
          maxSeconds={workspaceEndSeconds}
          onCommit={(seconds) => commitEdge("start", seconds)}
        />
        <EdgeField
          label={t("setlistView.edit.end")}
          seconds={region.endSeconds}
          song={song}
          maxSeconds={workspaceEndSeconds}
          onCommit={(seconds) => commitEdge("end", seconds)}
        />
        {previous ? (
          <Field label={t("setlistView.edit.gap", { name: previous.name })}>
            <input
              className="lt-setlist-settings-input"
              inputMode="decimal"
              value={gapDraft}
              aria-label={t("setlistView.edit.gap", { name: previous.name })}
              onChange={(event) => setGapDraft(event.target.value)}
              onBlur={commitGap}
              onKeyDown={(event) => event.key === "Enter" && commitGap()}
            />
            <span className="lt-setlist-settings-unit">{t("setlistView.edit.bars")}</span>
          </Field>
        ) : null}
      </SettingsSection>

      <SettingsSection icon="more_horiz" title={t("setlistView.edit.actionsSection")}>
        <div className="lt-setlist-settings-row">
          <ActionButton action={entry("transport.menu.analyzeSong")} />
          <ActionButton action={entry("transport.menu.renderSong")} />
          <ActionButton action={entry("transport.menu.exportSong")} />
          <ActionButton action={entry("transport.menu.deleteSong")} />
        </div>
      </SettingsSection>
    </div>
  );
}

export const SetlistSongSettings = memo(SetlistSongSettingsComponent);
