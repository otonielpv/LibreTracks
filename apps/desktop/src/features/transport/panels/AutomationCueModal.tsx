import { useState } from "react";

import type {
  AutomationActionSummary,
  AutomationJumpTargetSummary,
  SongView,
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
  onCancel: () => void;
  onConfirm: (result: {
    actions: AutomationActionSummary[];
    maxRuns: number | null;
  }) => void;
};

const FRAME_OPTION = "__frame__";

const ACTION_LABELS: Record<AutomationActionSummary["type"], string> = {
  jump: "Saltar a…",
  setTrackMute: "Mute / Unmute pista",
  setTrackSolo: "Solo / Unsolo pista",
  setTrackMix: "Volumen / paneo",
  applyScene: "Aplicar escena",
  wait: "Esperar",
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
  onCancel,
  onConfirm,
}: AutomationCueModalProps) {
  const [actions, setActions] = useState<AutomationActionSummary[]>(
    () => draft?.actions ?? [],
  );
  // null = unlimited (∞). When limited, the numeric value (≥1).
  const [maxRuns, setMaxRuns] = useState<number | null>(
    () => draft?.maxRuns ?? null,
  );

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
    setActions((prev) => normalize([...prev, makeAction(type, song)]));

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
            <span className="lt-settings-modal-eyebrow">Automatismo</span>
            <h2 id="lt-automation-modal-title">
              {isEditing ? "Editar automatismo" : "Nuevo automatismo"}
            </h2>
            <p>En {formatClock(draft.atSeconds)}</p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-automation-actions-body">
          {actions.length === 0 ? (
            <p className="lt-automation-empty">
              Añade acciones para este automatismo.
            </p>
          ) : (
            actions.map((action, index) => (
              <div className="lt-automation-action-row" key={index}>
                <div className="lt-automation-action-head">
                  <span className="lt-automation-action-kind">
                    {ACTION_LABELS[action.type]}
                  </span>
                  <div className="lt-automation-action-tools">
                    {/* The jump is pinned last, so it can't be reordered, and
                        no action can move below it. */}
                    {action.type !== "jump" ? (
                      <>
                        <button
                          type="button"
                          aria-label="Subir"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label="Bajar"
                          disabled={index >= lastMovableIndex}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      aria-label="Quitar acción"
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
                  onChange={(next) => updateAt(index, next)}
                />
              </div>
            ))
          )}

          <div className="lt-automation-add-row">
            <span className="lt-settings-field-label">Añadir acción</span>
            <div className="lt-automation-add-buttons">
              {(
                [
                  "jump",
                  "setTrackMute",
                  "setTrackSolo",
                  "setTrackMix",
                  "applyScene",
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
                  {ACTION_LABELS[type]}
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
              Limitar repeticiones
            </label>
            {maxRuns != null ? (
              <label className="lt-settings-field lt-automation-runs-field">
                <span className="lt-settings-field-label">Veces</span>
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
              <span className="lt-automation-runs-hint">∞ (siempre)</span>
            )}
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button
            type="button"
            className="lt-secondary-button"
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({ actions: normalize(actions), maxRuns })
            }
          >
            {isEditing ? "Guardar" : "Crear"}
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
  onChange: (next: AutomationActionSummary) => void;
};

function ActionEditor({
  action,
  regions,
  markers,
  tracks,
  scenes,
  onChange,
}: EditorProps) {
  if (action.type === "jump") {
    const value = encodeTarget(action.target);
    const frameSeconds =
      action.target.kind === "frame" ? action.target.seconds : 0;
    return (
      <div className="lt-automation-action-fields">
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">Destino</span>
          <select
            value={value}
            onChange={(event) => {
              const target = decodeTarget(event.target.value, frameSeconds);
              if (target) onChange({ ...action, target });
            }}
          >
            {regions.length > 0 ? (
              <optgroup label="Canciones">
                {regions.map((r) => (
                  <option key={r.id} value={`region:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {markers.length > 0 ? (
              <optgroup label="Marcas">
                {markers.map((m) => (
                  <option key={m.id} value={`marker:${m.id}`}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Otro">
              <option value={FRAME_OPTION}>Posición exacta…</option>
            </optgroup>
          </select>
        </label>
        {value === FRAME_OPTION ? (
          <label className="lt-settings-field">
            <span className="lt-settings-field-label">Segundos</span>
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
          <span className="lt-settings-field-label">Fade out (s)</span>
          <small className="lt-settings-field-hint">0 = instantáneo</small>
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
          onChange={(trackId) => onChange({ ...action, trackId })}
        />
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">
            {isMute ? "Mutear" : "Solo"}
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
            <option value="on">Activar</option>
            <option value="off">Desactivar</option>
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
          onChange={(trackId) => onChange({ ...action, trackId })}
        />
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">Volumen (0–100)</span>
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
          <span className="lt-settings-field-label">Paneo (L−100 / R+100)</span>
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
          <span className="lt-settings-field-label">Suavizado (s)</span>
          <small className="lt-settings-field-hint">
            0 = cambio inmediato
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
          <span className="lt-settings-field-label">Escena</span>
          <select
            value={action.sceneId}
            onChange={(event) =>
              onChange({ ...action, sceneId: event.target.value })
            }
          >
            <option value="" disabled>
              {scenes.length ? "Elige una escena…" : "No hay escenas"}
            </option>
            {scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.name}
              </option>
            ))}
          </select>
        </label>
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">Suavizado (s)</span>
          <small className="lt-settings-field-hint">0 = inmediato</small>
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

  // wait
  return (
    <div className="lt-automation-action-fields">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">Esperar (s)</span>
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

function TrackSelect({
  tracks,
  value,
  onChange,
}: {
  tracks: SongView["tracks"];
  value: string;
  onChange: (trackId: string) => void;
}) {
  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">Pista</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>
          {tracks.length ? "Elige una pista…" : "No hay pistas"}
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
