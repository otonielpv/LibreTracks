import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MixSceneRule, MixSceneSummary, SongView } from "../desktopApi";
import { useSoundingKeyStore } from "../keyChanges/soundingKeyStore";
import { useDismissOnBack } from "../mobile/backNavigation";
import { CommitInput, SceneRuleCard } from "./mixScenes/SceneRuleCard";
import {
  createSceneId,
  defaultRule,
  folderNames,
  bandDownScene,
  moveId,
  resolveSceneTrackIds,
} from "./mixScenes/sceneRules";
import { groupTracksBySong } from "./trackSongGroups";

type MixSceneModalProps = {
  open: boolean;
  song: SongView | null;
  onCancel: () => void;
  /** Persist a created/edited scene. */
  onUpsert: (scene: MixSceneSummary) => Promise<void> | void;
  /** Delete a scene by id. */
  onDelete: (sceneId: string) => Promise<void> | void;
  /** Persist the scenes' order (the MIDI scene slots follow it). */
  onReorder: (sceneIds: string[]) => Promise<void> | void;
};

/**
 * Mix scenes editor (plan live-scenes, paso 03): the scenes on the left, in
 * the order the `scene_slot` MIDI targets follow, and the selected scene's
 * rules on the right, each read as a sentence: "all the song's tracks except
 * names with voz, vox → volume -12 dB". Below, the tracks it touches in the
 * song under the playhead.
 */
export function MixSceneModal({
  open,
  song,
  onCancel,
  onUpsert,
  onDelete,
  onReorder,
}: MixSceneModalProps) {
  // A stable callback: an unstable one re-registers and reorders the back
  // stack on every render (project_back_dismiss_reregister_trap).
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const dismiss = useCallback(() => cancelRef.current(), []);
  useDismissOnBack(dismiss, open);
  const { t } = useTranslation();
  const activeRegionId = useSoundingKeyStore((state) => state.regionId);

  // Edits show at once; the song view catches up after the save round trip.
  const persisted = song?.mixScenes;
  const [scenes, setScenes] = useState<MixSceneSummary[]>(persisted ?? []);
  useEffect(() => setScenes(persisted ?? []), [persisted]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => persisted?.[0]?.id ?? null,
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (!open) {
    return null;
  }

  const selected = scenes.find((scene) => scene.id === selectedId) ?? null;
  const folders = folderNames(song);
  const trackGroups = groupTracksBySong(song);

  const saveScene = (next: MixSceneSummary) => {
    setScenes((current) =>
      current.some((scene) => scene.id === next.id)
        ? current.map((scene) => (scene.id === next.id ? next : scene))
        : [...current, next],
    );
    void onUpsert(next);
  };

  const addScene = (scene: MixSceneSummary) => {
    saveScene(scene);
    setSelectedId(scene.id);
  };

  const createScene = () =>
    addScene({
      id: createSceneId(),
      name: t("transport.mixScene.defaultName", { index: scenes.length + 1 }),
      rampSeconds: 1,
      rules: [],
    });

  const createBandDownScene = () =>
    addScene(bandDownScene(createSceneId(), t("transport.mixScene.bandDownName")));

  const moveScene = (from: number, to: number) => {
    const current = scenes.map((scene) => scene.id);
    const ids = moveId(current, from, to);
    if (ids === current) return;
    setScenes(ids.map((id) => scenes.find((scene) => scene.id === id)!));
    void onReorder(ids);
  };

  const patchRule = (index: number, rule: MixSceneRule) => {
    if (!selected) return;
    saveScene({
      ...selected,
      rules: selected.rules.map((current, i) => (i === index ? rule : current)),
    });
  };

  const removeRule = (index: number) => {
    if (!selected) return;
    saveScene({ ...selected, rules: selected.rules.filter((_, i) => i !== index) });
  };

  const previewIds = selected
    ? resolveSceneTrackIds(selected, song, activeRegionId || null)
    : [];
  const trackName = (id: string) =>
    song?.tracks.find((track) => track.id === id)?.name ?? id;
  const hasActiveSong = Boolean(activeRegionId);

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
            <span className="lt-settings-modal-eyebrow">
              {t("transport.mixScene.eyebrow")}
            </span>
            <h2 id="lt-scene-modal-title">{t("transport.mixScene.title")}</h2>
            <p>{t("transport.mixScene.description")}</p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-scene-body">
          <div className="lt-scene-list">
            {scenes.length === 0 ? (
              <p className="lt-automation-empty">{t("transport.mixScene.empty")}</p>
            ) : (
              <ol className="lt-scene-list-items">
                {scenes.map((scene, index) => (
                  <li
                    key={scene.id}
                    className={`lt-scene-list-item ${
                      scene.id === selectedId ? "is-selected" : ""
                    } ${dragIndex === index ? "is-dragging" : ""}`}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) moveScene(dragIndex, index);
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <button
                      type="button"
                      className="lt-scene-list-select"
                      aria-pressed={scene.id === selectedId}
                      onClick={() => setSelectedId(scene.id)}
                    >
                      <span className="lt-scene-list-number">{index + 1}</span>
                      <span className="lt-scene-list-text">
                        <span className="lt-scene-list-name">{scene.name}</span>
                        <span className="lt-scene-list-meta">
                          {t("transport.mixScene.rulesCount", { count: scene.rules.length })}
                        </span>
                      </span>
                    </button>
                    <span className="lt-scene-list-move">
                      <button
                        type="button"
                        className="lt-scene-icon-button"
                        aria-label={t("transport.mixScene.moveUp", { name: scene.name })}
                        disabled={index === 0}
                        onClick={() => moveScene(index, index - 1)}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true">
                          arrow_upward
                        </span>
                      </button>
                      <button
                        type="button"
                        className="lt-scene-icon-button"
                        aria-label={t("transport.mixScene.moveDown", { name: scene.name })}
                        disabled={index === scenes.length - 1}
                        onClick={() => moveScene(index, index + 1)}
                      >
                        <span className="material-symbols-outlined" aria-hidden="true">
                          arrow_downward
                        </span>
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <button type="button" className="lt-secondary-button lt-scene-add" onClick={createScene}>
              {t("transport.mixScene.newScene")}
            </button>
            <button
              type="button"
              className="lt-secondary-button lt-scene-add is-template"
              onClick={createBandDownScene}
            >
              {t("transport.mixScene.bandDownTemplate")}
            </button>
          </div>

          <div className="lt-scene-detail">
            {selected ? (
              <>
                <div className="lt-scene-detail-head">
                  <label className="lt-scene-field lt-scene-name-field">
                    <span className="lt-scene-change-label">{t("transport.mixScene.name")}</span>
                    <input
                      type="text"
                      value={selected.name}
                      onChange={(event) => saveScene({ ...selected, name: event.target.value })}
                    />
                  </label>
                  <label className="lt-scene-field lt-scene-ramp-field">
                    <span className="lt-scene-change-label">
                      {t("transport.mixScene.rampSeconds")}
                    </span>
                    <CommitInput
                      type="number"
                      ariaLabel={t("transport.mixScene.rampSeconds")}
                      suffix="s"
                      value={String(selected.rampSeconds)}
                      onCommit={(text) => {
                        const seconds = Number(text);
                        if (Number.isFinite(seconds)) {
                          saveScene({ ...selected, rampSeconds: Math.min(30, Math.max(0, seconds)) });
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="lt-secondary-button lt-scene-delete"
                    onClick={() => {
                      void Promise.resolve(onDelete(selected.id)).then(() => setSelectedId(null));
                    }}
                  >
                    {t("transport.mixScene.deleteScene")}
                  </button>
                </div>

                <div className="lt-scene-rules">
                  {selected.rules.length === 0 ? (
                    <p className="lt-automation-empty">{t("transport.mixScene.noRules")}</p>
                  ) : (
                    selected.rules.map((rule, index) => (
                      <SceneRuleCard
                        key={index}
                        index={index}
                        rule={rule}
                        folders={folders}
                        trackGroups={trackGroups}
                        onChange={(next) => patchRule(index, next)}
                        onRemove={() => removeRule(index)}
                      />
                    ))
                  )}
                  <button
                    type="button"
                    className="lt-secondary-button lt-scene-add-rule"
                    onClick={() =>
                      saveScene({ ...selected, rules: [...selected.rules, defaultRule()] })
                    }
                  >
                    {t("transport.mixScene.addRule")}
                  </button>
                </div>

                <p className="lt-scene-preview" aria-live="polite">
                  {!hasActiveSong
                    ? t("transport.mixScene.previewNoSong")
                    : previewIds.length === 0
                      ? t("transport.mixScene.previewNone")
                      : t("transport.mixScene.preview", {
                          names: previewIds.map(trackName).join(", "),
                          count: previewIds.length,
                        })}
                </p>
              </>
            ) : (
              <p className="lt-automation-empty">{t("transport.mixScene.selectOrCreate")}</p>
            )}
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button type="button" className="is-primary" onClick={onCancel}>
            {t("common.close")}
          </button>
        </div>
      </section>
    </div>
  );
}
