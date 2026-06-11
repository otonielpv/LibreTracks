import { useMemo, useState } from "react";

import type {
  AutomationJumpTargetSummary,
  SongView,
} from "../desktopApi";
import { formatClock } from "../helpers";

/**
 * What the modal is operating on. `atSeconds` is the timeline position where the
 * cue fires. `cueId`/`name` are present when editing an existing cue; absent
 * when creating a new one. `target`/`fadeSeconds` seed the controls.
 */
export type AutomationCueDraft = {
  atSeconds: number;
  cueId: string | null;
  name: string | null;
  target: AutomationJumpTargetSummary | null;
  fadeSeconds: number;
};

type AutomationCueModalProps = {
  draft: AutomationCueDraft | null;
  song: SongView | null;
  onCancel: () => void;
  onConfirm: (result: {
    target: AutomationJumpTargetSummary;
    fadeSeconds: number;
  }) => void;
};

// Encode/decode the target as a single <select> value so regions, markers and
// the "exact position" option can coexist in one control.
const FRAME_OPTION = "__frame__";

function encodeTarget(target: AutomationJumpTargetSummary | null): string {
  if (!target) {
    return "";
  }
  if (target.kind === "region") {
    return `region:${target.regionId}`;
  }
  if (target.kind === "marker") {
    return `marker:${target.markerId}`;
  }
  return FRAME_OPTION;
}

/**
 * Visual editor for a jump automation cue. Replaces the old pair of free-text
 * prompts (type the destination name, then the fade seconds) with a proper
 * destination picker + fade control, mirroring ExportSongModal's structure.
 */
export function AutomationCueModal({
  draft,
  song,
  onCancel,
  onConfirm,
}: AutomationCueModalProps) {
  const [selectValue, setSelectValue] = useState(() =>
    encodeTarget(draft?.target ?? null),
  );
  const [frameSeconds, setFrameSeconds] = useState(() =>
    draft?.target?.kind === "frame" ? draft.target.seconds : (draft?.atSeconds ?? 0),
  );
  const [fadeSeconds, setFadeSeconds] = useState(() => draft?.fadeSeconds ?? 0);

  const regions = song?.regions ?? [];
  const markers = song?.sectionMarkers ?? [];

  const resolvedTarget = useMemo<AutomationJumpTargetSummary | null>(() => {
    if (selectValue === FRAME_OPTION) {
      return Number.isFinite(frameSeconds) && frameSeconds >= 0
        ? { kind: "frame", seconds: frameSeconds }
        : null;
    }
    if (selectValue.startsWith("region:")) {
      return { kind: "region", regionId: selectValue.slice("region:".length) };
    }
    if (selectValue.startsWith("marker:")) {
      return { kind: "marker", markerId: selectValue.slice("marker:".length) };
    }
    return null;
  }, [selectValue, frameSeconds]);

  if (!draft) {
    return null;
  }

  const isEditing = draft.cueId !== null;
  const canConfirm =
    resolvedTarget !== null && Number.isFinite(fadeSeconds) && fadeSeconds >= 0;

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

        <div className="lt-settings-modal-body">
          <label className="lt-settings-field">
            <span className="lt-settings-field-label">Saltar a</span>
            <select
              value={selectValue}
              onChange={(event) => setSelectValue(event.target.value)}
            >
              <option value="" disabled>
                Elige un destino…
              </option>
              {regions.length > 0 ? (
                <optgroup label="Canciones">
                  {regions.map((region) => (
                    <option key={region.id} value={`region:${region.id}`}>
                      {region.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {markers.length > 0 ? (
                <optgroup label="Marcas">
                  {markers.map((marker) => (
                    <option key={marker.id} value={`marker:${marker.id}`}>
                      {marker.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="Otro">
                <option value={FRAME_OPTION}>Posición exacta…</option>
              </optgroup>
            </select>
          </label>

          {selectValue === FRAME_OPTION ? (
            <label className="lt-settings-field">
              <span className="lt-settings-field-label">Segundos</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={frameSeconds}
                onChange={(event) =>
                  setFrameSeconds(Number(event.target.value))
                }
              />
            </label>
          ) : null}

          <label className="lt-settings-field">
            <span className="lt-settings-field-label">
              Fade out antes del salto (s)
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={fadeSeconds}
              onChange={(event) => setFadeSeconds(Number(event.target.value))}
            />
            <small className="lt-settings-field-hint">
              0 = salto instantáneo
            </small>
          </label>
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
            onClick={() => {
              if (!resolvedTarget) {
                return;
              }
              onConfirm({ target: resolvedTarget, fadeSeconds });
            }}
          >
            {isEditing ? "Guardar" : "Crear"}
          </button>
        </div>
      </section>
    </div>
  );
}
