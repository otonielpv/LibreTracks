import { useState } from "react";

import type { MixSceneSummary, SongView } from "../desktopApi";

type MixSceneModalProps = {
  open: boolean;
  song: SongView | null;
  onCancel: () => void;
  /** Persist a created/edited scene. */
  onUpsert: (scene: MixSceneSummary) => Promise<void> | void;
  /** Delete a scene by id. */
  onDelete: (sceneId: string) => Promise<void> | void;
};

function createSceneId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `scene-${crypto.randomUUID()}`;
  }
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Manage mix scenes: a list of scenes (create / rename / delete) and, for the
 * selected scene, optional per-track overrides (volume / pan / mute / solo).
 * Each parameter is independently toggled — unchecked params are left untouched
 * when the scene is applied. Mirrors the AutomationCueModal structure.
 */
export function MixSceneModal({
  open,
  song,
  onCancel,
  onUpsert,
  onDelete,
}: MixSceneModalProps) {
  const scenes = song?.mixScenes ?? [];
  const tracks = (song?.tracks ?? []).filter((t) => t.kind !== "folder");

  const [selectedId, setSelectedId] = useState<string | null>(
    () => scenes[0]?.id ?? null,
  );

  if (!open) {
    return null;
  }

  const selected = scenes.find((s) => s.id === selectedId) ?? null;

  const overrideFor = (trackId: string) =>
    selected?.trackOverrides.find((o) => o.trackId === trackId);

  // Replace one track's override inside the selected scene and persist.
  const patchOverride = (
    trackId: string,
    patch: Partial<{
      volume: number | null;
      pan: number | null;
      muted: boolean | null;
      solo: boolean | null;
    }>,
  ) => {
    if (!selected) return;
    const existing = overrideFor(trackId);
    const merged = {
      trackId,
      volume: existing?.volume ?? null,
      pan: existing?.pan ?? null,
      muted: existing?.muted ?? null,
      solo: existing?.solo ?? null,
      ...patch,
    };
    // Drop the override entirely when nothing is set anymore.
    const isEmpty =
      merged.volume == null &&
      merged.pan == null &&
      merged.muted == null &&
      merged.solo == null;
    const nextOverrides = selected.trackOverrides.filter(
      (o) => o.trackId !== trackId,
    );
    if (!isEmpty) {
      nextOverrides.push(merged);
    }
    void onUpsert({ ...selected, trackOverrides: nextOverrides });
  };

  const createScene = () => {
    const scene: MixSceneSummary = {
      id: createSceneId(),
      name: `Escena ${scenes.length + 1}`,
      trackOverrides: [],
    };
    void Promise.resolve(onUpsert(scene)).then(() => setSelectedId(scene.id));
  };

  const renameScene = (scene: MixSceneSummary, name: string) => {
    void onUpsert({ ...scene, name });
  };

  return (
    <div className="lt-modal-backdrop" onClick={onCancel}>
      <section
        className="lt-settings-modal lt-scene-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-scene-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">Mezcla</span>
            <h2 id="lt-scene-modal-title">Escenas de mezcla</h2>
            <p>Configura overrides de pista para aplicar desde un automatismo.</p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-scene-body">
          <div className="lt-scene-list">
            {scenes.length === 0 ? (
              <p className="lt-automation-empty">No hay escenas todavía.</p>
            ) : (
              scenes.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  className={`lt-scene-list-item ${
                    scene.id === selectedId ? "is-selected" : ""
                  }`}
                  onClick={() => setSelectedId(scene.id)}
                >
                  {scene.name}
                  <span className="lt-scene-list-meta">
                    {scene.trackOverrides.length} pistas
                  </span>
                </button>
              ))
            )}
            <button
              type="button"
              className="lt-secondary-button lt-scene-add"
              onClick={createScene}
            >
              + Nueva escena
            </button>
          </div>

          <div className="lt-scene-detail">
            {selected ? (
              <>
                <div className="lt-scene-detail-head">
                  <label className="lt-settings-field">
                    <span className="lt-settings-field-label">Nombre</span>
                    <input
                      type="text"
                      value={selected.name}
                      onChange={(event) =>
                        renameScene(selected, event.target.value)
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="lt-secondary-button"
                    onClick={() => {
                      void Promise.resolve(onDelete(selected.id)).then(() =>
                        setSelectedId(null),
                      );
                    }}
                  >
                    Eliminar escena
                  </button>
                </div>

                <div className="lt-scene-tracks">
                  {tracks.length === 0 ? (
                    <p className="lt-automation-empty">No hay pistas.</p>
                  ) : (
                    tracks.map((track) => {
                      const ov = overrideFor(track.id);
                      return (
                        <div className="lt-scene-track-row" key={track.id}>
                          <span className="lt-scene-track-name">
                            {track.name}
                          </span>
                          <OverrideToggle
                            label="Vol"
                            active={ov?.volume != null}
                            onToggle={(on) =>
                              patchOverride(track.id, {
                                volume: on ? 1 : null,
                              })
                            }
                          >
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={1}
                              value={Math.round((ov?.volume ?? 1) * 100)}
                              onChange={(event) =>
                                patchOverride(track.id, {
                                  volume: Number(event.target.value) / 100,
                                })
                              }
                            />
                          </OverrideToggle>
                          <OverrideToggle
                            label="Pan"
                            active={ov?.pan != null}
                            onToggle={(on) =>
                              patchOverride(track.id, { pan: on ? 0 : null })
                            }
                          >
                            <input
                              type="number"
                              min={-100}
                              max={100}
                              step={1}
                              value={Math.round((ov?.pan ?? 0) * 100)}
                              onChange={(event) =>
                                patchOverride(track.id, {
                                  pan: Number(event.target.value) / 100,
                                })
                              }
                            />
                          </OverrideToggle>
                          <OverrideToggle
                            label="Mute"
                            active={ov?.muted != null}
                            onToggle={(on) =>
                              patchOverride(track.id, {
                                muted: on ? true : null,
                              })
                            }
                          >
                            <select
                              value={ov?.muted ? "on" : "off"}
                              onChange={(event) =>
                                patchOverride(track.id, {
                                  muted: event.target.value === "on",
                                })
                              }
                            >
                              <option value="on">Mute</option>
                              <option value="off">Sin mute</option>
                            </select>
                          </OverrideToggle>
                          <OverrideToggle
                            label="Solo"
                            active={ov?.solo != null}
                            onToggle={(on) =>
                              patchOverride(track.id, {
                                solo: on ? true : null,
                              })
                            }
                          >
                            <select
                              value={ov?.solo ? "on" : "off"}
                              onChange={(event) =>
                                patchOverride(track.id, {
                                  solo: event.target.value === "on",
                                })
                              }
                            >
                              <option value="on">Solo</option>
                              <option value="off">Sin solo</option>
                            </select>
                          </OverrideToggle>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <p className="lt-automation-empty">
                Selecciona o crea una escena para editarla.
              </p>
            )}
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button
            type="button"
            className="is-primary"
            onClick={onCancel}
          >
            Cerrar
          </button>
        </div>
      </section>
    </div>
  );
}

/** A parameter override cell: a checkbox that enables/disables the override,
 * and the control (shown only when active). */
function OverrideToggle({
  label,
  active,
  onToggle,
  children,
}: {
  label: string;
  active: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`lt-scene-override ${active ? "is-active" : ""}`}>
      <label className="lt-scene-override-toggle">
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => onToggle(event.target.checked)}
        />
        {label}
      </label>
      {active ? <div className="lt-scene-override-control">{children}</div> : null}
    </div>
  );
}
