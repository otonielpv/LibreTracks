import { useTranslation } from "react-i18next";
import { create } from "zustand";

import type { MixSceneMode, MixSceneSummary } from "@libretracks/shared/models";

import { useNetworkPermissions } from "../../network/useNetworkPermissions";
import { MidiMappable } from "../midi/MidiMappable";
import { useTransportStore } from "../store";
import "./SceneButtons.css";

/**
 * How a scene button reaches the backend. The transport panel registers its
 * handler once (`useMixSceneHandlers`), so Live, Setlist and the compact
 * view can host buttons without threading a callback through their props.
 */
export const useMixSceneTriggerStore = create<{
  trigger: ((sceneId: string, mode?: MixSceneMode) => void) | null;
}>()(() => ({ trigger: null }));

/** The MIDI target a scene button learns (plan live-scenes, D10). */
export function sceneToggleTarget(sceneId: string) {
  return `scene:${sceneId}:toggle`;
}

const NO_IDS: string[] = [];
const NO_SCENES: MixSceneSummary[] = [];

type SceneButtonsProps = {
  /** Extra class for where it sits (Live header, Setlist mixer, compact). */
  className?: string;
  /** A guest of a network session or a read-only view: shown, not usable. */
  disabled?: boolean;
};

/**
 * One button per mix scene, in the editor's order, lit while engaged
 * (plan live-scenes, paso 04). A tap toggles. Nothing renders without
 * scenes. The row scrolls sideways when it does not fit, so on a phone
 * every scene stays one tap away.
 */
export function SceneButtons({ className, disabled = false }: SceneButtonsProps) {
  const { t } = useTranslation();
  const scenes = useTransportStore((state) => state.playback?.mixScenes ?? NO_SCENES);
  const activeIds = useTransportStore((state) => state.playback?.activeMixSceneIds ?? NO_IDS);
  const trigger = useMixSceneTriggerStore((state) => state.trigger);
  // Scenes from a network guest are out of the plan: the host does not
  // proxy `trigger_mix_scene` yet.
  const { isGuest } = useNetworkPermissions();

  if (scenes.length === 0) {
    return null;
  }

  return (
    <div
      className={`lt-scene-buttons${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={t("transport.mixScene.buttonsLabel")}
    >
      {scenes.map((scene, index) => {
        const active = activeIds.includes(scene.id);
        return (
          <MidiMappable key={scene.id} target={sceneToggleTarget(scene.id)} label={scene.name}>
            <button
              type="button"
              className={`lt-scene-button${active ? " is-active" : ""}`}
              aria-pressed={active}
              disabled={disabled || isGuest || !trigger}
              title={t(active ? "transport.mixScene.buttonRelease" : "transport.mixScene.buttonEngage", {
                name: scene.name,
              })}
              onClick={() => trigger?.(scene.id, "toggle")}
            >
              <span className="lt-scene-button-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="lt-scene-button-name">{scene.name}</span>
            </button>
          </MidiMappable>
        );
      })}
    </div>
  );
}
