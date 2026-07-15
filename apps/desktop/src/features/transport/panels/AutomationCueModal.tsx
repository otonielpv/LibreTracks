import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AUX_FADER_SCALE,
  formatGainDb,
  gainToPosition,
  positionToGain,
} from "@libretracks/shared/faderScale";

import {
  getPadsCatalog,
  type AppSettings,
  type AutomationActionSummary,
  type AutomationJumpTargetSummary,
  type PadCatalogEntry,
  type SongView,
} from "../desktopApi";
import { formatClock } from "../helpers";

/**
 * What the modal is operating on. `cueId`/`name` are present when editing an
 * existing cue. `actions` seeds the editable job list.
 */
export type AutomationCueDraft = {
  atSeconds: number;
  cueId: string | null;
  name: string | null;
  /** Max times the cue fires per session; null = unlimited. */
  maxRuns: number | null;
  actions: AutomationActionSummary[];
};

type AutomationCueModalProps = {
  draft: AutomationCueDraft | null;
  song: SongView | null;
  appSettings: AppSettings;
  padRouteOptions: Array<{ value: string; label: string }>;
  onCancel: () => void;
  onConfirm: (result: {
    actions: AutomationActionSummary[];
    maxRuns: number | null;
  }) => void;
};

const FRAME_OPTION = "__frame__";

const ACTION_LABEL_KEYS: Record<AutomationActionSummary["type"], string> = {
  jump: "transport.automation.actionJump",
  setTrackMute: "transport.automation.actionMute",
  setTrackSolo: "transport.automation.actionSolo",
  setTrackMix: "transport.automation.actionMix",
  applyScene: "transport.automation.actionScene",
  setPad: "transport.automation.actionPad",
  wait: "transport.automation.actionWait",
};

function encodeTarget(target: AutomationJumpTargetSummary): string {
  if (target.kind === "region") return `region:${target.regionId}`;
  if (target.kind === "marker") return `marker:${target.markerId}`;
  return FRAME_OPTION;
}

function decodeTarget(
  value: string,
  frameSeconds: number,
): AutomationJumpTargetSummary | null {
  if (value === FRAME_OPTION) {
    return Number.isFinite(frameSeconds) && frameSeconds >= 0
      ? { kind: "frame", seconds: frameSeconds }
      : null;
  }
  if (value.startsWith("region:")) {
    return { kind: "region", regionId: value.slice("region:".length) };
  }
  if (value.startsWith("marker:")) {
    return { kind: "marker", markerId: value.slice("marker:".length) };
  }
  return null;
}

/** A fresh action of the given type, seeded with sensible defaults. */
function makeAction(
  type: AutomationActionSummary["type"],
  song: SongView | null,
  appSettings: AppSettings,
): AutomationActionSummary {
  const firstTrack = song?.tracks.find((t) => t.kind !== "folder")?.id ?? "";
  const firstScene = song?.mixScenes?.[0]?.id ?? "";
  switch (type) {
    case "jump": {
      const region = song?.regions?.[0];
      const marker = song?.sectionMarkers?.[0];
      const target: AutomationJumpTargetSummary = region
        ? { kind: "region", regionId: region.id }
        : marker
          ? { kind: "marker", markerId: marker.id }
          : { kind: "frame", seconds: 0 };
      return { type: "jump", target, transition: { mode: "instant" } };
    }
    case "setTrackMute":
      return { type: "setTrackMute", trackId: firstTrack, muted: true };
    case "setTrackSolo":
      return { type: "setTrackSolo", trackId: firstTrack, solo: true };
    case "setTrackMix":
      return { type: "setTrackMix", trackId: firstTrack, volume: 1, pan: 0 };
    case "applyScene":
      return { type: "applyScene", sceneId: firstScene };
    case "setPad":
      return {
        type: "setPad",
        enabled: appSettings.padEnabled,
        padId: appSettings.padId,
        padKey: appSettings.padKey,
        volume: appSettings.padVolume,
        output: appSettings.padOutput,
      };
    case "wait":
      return { type: "wait", durationSeconds: 1 };
  }
}

/**
 * Visual editor for a cue's job: an ordered list of actions (jump, mute, solo,
 * mix, apply-scene, wait) with add/remove/reorder. A jump, if present, is forced
 * to the last position (it's the job's culmination).
 */
export function AutomationCueModal({
  draft,
  song,
  appSettings,
  padRouteOptions,
  onCancel,
  onConfirm,
}: AutomationCueModalProps) {
  const { t } = useTranslation();
  const [actions, setActions] = useState<AutomationActionSummary[]>(
    () => draft?.actions ?? [],
  );
  // null = unlimited (∞). When limited, the numeric value (≥1).
  const [maxRuns, setMaxRuns] = useState<number | null>(
    () => draft?.maxRuns ?? null,
  );
  const [installedPads, setInstalledPads] = useState<PadCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getPadsCatalog().then((catalog) => {
      if (!cancelled) setInstalledPads(catalog.pads.filter((pad) => pad.installed));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!draft) {
    return null;
  }

  const regions = song?.regions ?? [];
  const markers = song?.sectionMarkers ?? [];
  const tracks = (song?.tracks ?? []).filter((t) => t.kind !== "folder");
  const scenes = song?.mixScenes ?? [];
  const isEditing = draft.cueId !== null;

  // Keep the jump (if any) last after every mutation.
  const normalize = (next: AutomationActionSummary[]) => {
    const jumps = next.filter((a) => a.type === "jump");
    const rest = next.filter((a) => a.type !== "jump");
    return [...rest, ...jumps];
  };

  const updateAt = (index: number, action: AutomationActionSummary) => {
    setActions((prev) => {
      const next = [...prev];
      next[index] = action;
      return normalize(next);
    });
  };

  const removeAt = (index: number) =>
    setActions((prev) => prev.filter((_, i) => i !== index));

  const move = (index: number, delta: number) =>
    setActions((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return normalize(next);
    });

  const addAction = (type: AutomationActionSummary["type"]) =>
    setActions((prev) => normalize([...prev, makeAction(type, song, appSettings)]));

  const hasJump = actions.some((a) => a.type === "jump");
  // Highest index a non-jump row may move down to: the slot just above the
  // pinned jump (or the last row when there's no jump).
  const lastMovableIndex = hasJump ? actions.length - 2 : actions.length - 1;

  const canConfirm = actions.length > 0 && validateActions(actions);

  return (
    <div className="lt-modal-backdrop" onClick={onCancel}>
      <section
        className="lt-settings-modal lt-automation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-automation-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.automation.modalEyebrow")}
            </span>
            <h2 id="lt-automation-modal-title">
              {t(
                isEditing
                  ? "transport.automation.modalEditTitle"
                  : "transport.automation.modalNewTitle",
              )}
            </h2>
            <p>
              {t("transport.automation.modalAtTime", {
                time: formatClock(draft.atSeconds),
              })}
            </p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-automation-actions-body">
          {actions.length === 0 ? (
            <p className="lt-automation-empty">
              {t("transport.automation.modalEmpty")}
            </p>
          ) : (
            actions.map((action, index) => (
              <div className="lt-automation-action-row" key={index}>
                <div className="lt-automation-action-head">
                  <span className="lt-automation-action-kind">
                    {t(ACTION_LABEL_KEYS[action.type])}
                  </span>
                  <div className="lt-automation-action-tools">
                    {/* The jump is pinned last, so it can't be reordered, and
                        no action can move below it. */}
                    {action.type !== "jump" ? (
                      <>
                        <button
                          type="button"
                          aria-label={t("transport.automation.moveUp")}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={t("transport.automation.moveDown")}
                          disabled={index >= lastMovableIndex}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t("transport.automation.removeAction")}
                      onClick={() => removeAt(index)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <ActionEditor
                  action={action}
                  regions={regions}
                  markers={markers}
                  tracks={tracks}
                  scenes={scenes}
                  installedPads={installedPads}
                  padRouteOptions={padRouteOptions}
                  t={t}
                  onChange={(next) => updateAt(index, next)}
                />
              </div>
            ))
          )}

          <div className="lt-automation-add-row">
            <span className="lt-settings-field-label">
              {t("transport.automation.addAction")}
            </span>
            <div className="lt-automation-add-buttons">
              {(
                [
                  "jump",
                  "setTrackMute",
                  "setTrackSolo",
                  "setTrackMix",
                  "applyScene",
                  "setPad",
                  "wait",
                ] as AutomationActionSummary["type"][]
              ).map((type) => (
                <button
                  key={type}
                  type="button"
                  className="lt-secondary-button"
                  // Only one jump per cue.
                  disabled={type === "jump" && hasJump}
                  onClick={() => addAction(type)}
                >
                  {t(ACTION_LABEL_KEYS[type])}
                </button>
              ))}
            </div>
          </div>

          {/* Repeat limit: bound how many times the cue fires per session, so a
              "jump back" loop runs only N times and then passes through. */}
          <div className="lt-automation-runs-row">
            <label className="lt-scene-override-toggle">
              <input
                type="checkbox"
                checked={maxRuns != null}
                onChange={(event) =>
                  setMaxRuns(event.target.checked ? 1 : null)
                }
              />
              {t("transport.automation.limitRuns")}
            </label>
            {maxRuns != null ? (
              <label className="lt-settings-field lt-automation-runs-field">
                <span className="lt-settings-field-label">
                  {t("transport.automation.runsCount")}
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={maxRuns}
                  onChange={(event) =>
                    setMaxRuns(Math.max(1, Math.floor(Number(event.target.value)) || 1))
                  }
                />
              </label>
            ) : (
              <span className="lt-automation-runs-hint">
                {t("transport.automation.unlimited")}
              </span>
            )}
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button
            type="button"
            className="lt-secondary-button"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({ actions: normalize(actions), maxRuns })
            }
          >
            {t(isEditing ? "common.save" : "common.create")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Client-side guard mirroring the backend: ids set, numbers finite. */
function validateActions(actions: AutomationActionSummary[]): boolean {
  return actions.every((action) => {
    switch (action.type) {
      case "jump":
        return (
          (action.target.kind !== "frame" || action.target.seconds >= 0) &&
          (action.transition.mode !== "fade_out" ||
            (action.transition.durationSeconds ?? 0) >= 0)
        );
      case "setTrackMute":
      case "setTrackSolo":
        return action.trackId !== "";
      case "setTrackMix":
        return action.trackId !== "";
      case "applyScene":
        return action.sceneId !== "";
      case "setPad":
        return action.padId.trim() !== "" &&
          Number.isInteger(action.padKey) && action.padKey >= 0 && action.padKey <= 11 &&
          Number.isFinite(action.volume) && action.volume >= 0 && action.volume <= 10 &&
          action.output.trim() !== "";
      case "wait":
        return Number.isFinite(action.durationSeconds) &&
          action.durationSeconds >= 0;
    }
  });
}

type EditorProps = {
  action: AutomationActionSummary;
  regions: SongView["regions"];
  markers: SongView["sectionMarkers"];
  tracks: SongView["tracks"];
  scenes: NonNullable<SongView["mixScenes"]>;
  installedPads: PadCatalogEntry[];
  padRouteOptions: Array<{ value: string; label: string }>;
  t: (key: string, options?: Record<string, unknown>) => string;
  onChange: (next: AutomationActionSummary) => void;
};

function ActionEditor({
  action,
  regions,
  markers,
  tracks,
  scenes,
  installedPads,
  padRouteOptions,
  t,
  onChange,
}: EditorProps) {
  if (action.type === "jump") {
    const value = encodeTarget(action.target);
    const frameSeconds =
      action.target.kind === "frame" ? action.target.seconds : 0;
    return (
      <div className="lt-automation-action-fields">
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.destination")}
          </span>
          <select
            value={value}
            onChange={(event) => {
              const target = decodeTarget(event.target.value, frameSeconds);
              if (target) onChange({ ...action, target });
            }}
          >
            {regions.length > 0 ? (
              <optgroup label={t("transport.automation.destinationSongs")}>
                {regions.map((r) => (
                  <option key={r.id} value={`region:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {markers.length > 0 ? (
              <optgroup label={t("transport.automation.destinationMarkers")}>
                {markers.map((m) => (
                  <option key={m.id} value={`marker:${m.id}`}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label={t("transport.automation.destinationOther")}>
              <option value={FRAME_OPTION}>
                {t("transport.automation.exactPosition")}
              </option>
            </optgroup>
          </select>
        </label>
        {value === FRAME_OPTION ? (
          <label className="lt-settings-field">
            <span className="lt-settings-field-label">
              {t("transport.automation.seconds")}
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={frameSeconds}
              onChange={(event) =>
                onChange({
                  ...action,
                  target: { kind: "frame", seconds: Number(event.target.value) },
                })
              }
            />
          </label>
        ) : null}
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.fadeOutSeconds")}
          </span>
          <small className="lt-settings-field-hint">
            {t("transport.automation.instantHint")}
          </small>
          <input
            type="number"
            min={0}
            step={0.1}
            value={action.transition.durationSeconds ?? 0}
            onChange={(event) => {
              const seconds = Number(event.target.value);
              onChange({
                ...action,
                transition:
                  seconds > 0
                    ? { mode: "fade_out", durationSeconds: seconds }
                    : { mode: "instant" },
              });
            }}
          />
        </label>
      </div>
    );
  }

  if (action.type === "setTrackMute" || action.type === "setTrackSolo") {
    const isMute = action.type === "setTrackMute";
    const checked = isMute
      ? (action as { muted: boolean }).muted
      : (action as { solo: boolean }).solo;
    return (
      <div className="lt-automation-action-fields">
        <TrackSelect
          tracks={tracks}
          value={action.trackId}
          t={t}
          onChange={(trackId) => onChange({ ...action, trackId })}
        />
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t(
              isMute
                ? "transport.automation.muteLabel"
                : "transport.automation.cueSolo",
            )}
          </span>
          <select
            value={checked ? "on" : "off"}
            onChange={(event) =>
              onChange(
                isMute
                  ? { ...action, muted: event.target.value === "on" }
                  : { ...action, solo: event.target.value === "on" },
              )
            }
          >
            <option value="on">{t("transport.automation.enableOption")}</option>
            <option value="off">
              {t("transport.automation.disableOption")}
            </option>
          </select>
        </label>
      </div>
    );
  }

  if (action.type === "setTrackMix") {
    return (
      <div className="lt-automation-action-fields">
        <TrackSelect
          tracks={tracks}
          value={action.trackId}
          t={t}
          onChange={(trackId) => onChange({ ...action, trackId })}
        />
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.volumeLabel")}
          </span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            // Stored 0–1; shown as 0–100.
            value={Math.round((action.volume ?? 1) * 100)}
            onChange={(event) =>
              onChange({ ...action, volume: Number(event.target.value) / 100 })
            }
          />
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.panLabel")}
          </span>
          <input
            type="number"
            min={-100}
            max={100}
            step={1}
            // Stored −1..1; shown as −100 (L) .. 100 (R).
            value={Math.round((action.pan ?? 0) * 100)}
            onChange={(event) =>
              onChange({ ...action, pan: Number(event.target.value) / 100 })
            }
          />
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.smoothingSeconds")}
          </span>
          <small className="lt-settings-field-hint">
            {t("transport.automation.immediateHint")}
          </small>
          <input
            type="number"
            min={0}
            step={0.1}
            value={action.rampSeconds ?? 0}
            onChange={(event) => {
              const seconds = Math.max(0, Number(event.target.value));
              onChange({
                ...action,
                rampSeconds: seconds > 0 ? seconds : null,
              });
            }}
          />
        </label>
      </div>
    );
  }

  if (action.type === "applyScene") {
    return (
      <div className="lt-automation-action-fields">
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.sceneLabel")}
          </span>
          <select
            value={action.sceneId}
            onChange={(event) =>
              onChange({ ...action, sceneId: event.target.value })
            }
          >
            <option value="" disabled>
              {t(
                scenes.length
                  ? "transport.automation.chooseScene"
                  : "transport.automation.noScenes",
              )}
            </option>
            {scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name}
              </option>
            ))}
          </select>
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.smoothingSeconds")}
          </span>
          <small className="lt-settings-field-hint">
            {t("transport.automation.immediateHint")}
          </small>
          <input
            type="number"
            min={0}
            step={0.1}
            value={action.rampSeconds ?? 0}
            onChange={(event) => {
              const seconds = Math.max(0, Number(event.target.value));
              onChange({
                ...action,
                rampSeconds: seconds > 0 ? seconds : null,
              });
            }}
          />
        </label>
      </div>
    );
  }

  if (action.type === "setPad") {
    const selectedPadMissing = action.padId !== "" &&
      !installedPads.some((pad) => pad.id === action.padId);
    const keyLabels = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
    return (
      <div className="lt-automation-action-fields">
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.padState")}
          </span>
          <select
            value={action.enabled ? "on" : "off"}
            onChange={(event) => onChange({ ...action, enabled: event.target.value === "on" })}
          >
            <option value="on">{t("transport.automation.enableOption")}</option>
            <option value="off">{t("transport.automation.disableOption")}</option>
          </select>
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.padPack")}
          </span>
          <select value={action.padId} onChange={(event) => onChange({ ...action, padId: event.target.value })}>
            <option value="" disabled>{t("transport.automation.choosePadPack")}</option>
            {selectedPadMissing ? <option value={action.padId}>{action.padId}</option> : null}
            {installedPads.map((pad) => <option key={pad.id} value={pad.id}>{pad.name}</option>)}
          </select>
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.padKey")}
          </span>
          <select value={action.padKey} onChange={(event) => onChange({ ...action, padKey: Number(event.target.value) })}>
            {keyLabels.map((key, index) => <option key={key} value={index}>{key}</option>)}
          </select>
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {t("transport.automation.padRouting")}
          </span>
          <select value={action.output} onChange={(event) => onChange({ ...action, output: event.target.value })}>
            {padRouteOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="lt-settings-field lt-automation-pad-volume">
          <span className="lt-settings-field-label">
            {t("transport.automation.padVolume")}: {formatGainDb(action.volume)}
          </span>
          <input
            className="lt-range-input"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={gainToPosition(action.volume, AUX_FADER_SCALE)}
            onChange={(event) => onChange({
              ...action,
              volume: positionToGain(Number(event.target.value), AUX_FADER_SCALE),
            })}
          />
        </label>
        {/* Ambos fades siempre: la entrada suave aplica cuando este cue activa
            el pad; la salida suave, cuando lo desactiva o cambia de nota/pack
            (el swap del pad saliente usa el fade-out). Mostrarlos siempre evita
            ocultar una opción válida según el estado momentáneo del cue. */}
        <PadCueFadeField
          action={action}
          field="fadeInSeconds"
          label={t("transport.automation.padFadeIn", {
            defaultValue: "Entrada suave (s)",
          })}
          onChange={onChange}
        />
        <PadCueFadeField
          action={action}
          field="fadeOutSeconds"
          label={t("transport.automation.padFadeOut", {
            defaultValue: "Salida suave (s)",
          })}
          onChange={onChange}
        />
      </div>
    );
  }

  // wait
  return (
    <div className="lt-automation-action-fields">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.automation.waitSeconds")}
        </span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={action.durationSeconds}
          onChange={(event) =>
            onChange({ ...action, durationSeconds: Number(event.target.value) })
          }
        />
      </label>
    </div>
  );
}

// Per-cue soft entrance/exit control. A checkbox arms the fade (defaulting to
// 2 s) plus a number input for its duration; unchecking clears it to 0 (= no
// fade / instant). `field` selects fadeInSeconds (enable cues) or fadeOutSeconds
// (disable cues) on the setPad action.
type SetPadAction = Extract<AutomationActionSummary, { type: "setPad" }>;

const PAD_CUE_FADE_DEFAULT = 2;

function PadCueFadeField({
  action,
  field,
  label,
  onChange,
}: {
  action: SetPadAction;
  field: "fadeInSeconds" | "fadeOutSeconds";
  label: string;
  onChange: (next: AutomationActionSummary) => void;
}) {
  const seconds = action[field] ?? 0;
  const enabled = seconds > 0;
  return (
    <label className="lt-settings-field lt-automation-pad-fade">
      <span className="lt-settings-field-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            onChange({
              ...action,
              [field]: event.target.checked ? PAD_CUE_FADE_DEFAULT : 0,
            })
          }
        />
        {label}
      </span>
      {enabled ? (
        <input
          type="number"
          min={0.1}
          max={30}
          step={0.1}
          value={seconds}
          onChange={(event) =>
            onChange({
              ...action,
              [field]: Math.min(30, Math.max(0, Number(event.target.value))),
            })
          }
        />
      ) : null}
    </label>
  );
}

function TrackSelect({
  tracks,
  value,
  t,
  onChange,
}: {
  tracks: SongView["tracks"];
  value: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  onChange: (trackId: string) => void;
}) {
  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.automation.trackLabel")}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>
          {t(
            tracks.length
              ? "transport.automation.chooseTrack"
              : "transport.automation.noTracks",
          )}
        </option>
        {tracks.map((track) => (
          <option key={track.id} value={track.id}>
            {track.name}
          </option>
        ))}
      </select>
    </label>
  );
}
