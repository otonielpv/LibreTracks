// Editor de kit (plan drum-loops, paso 09): hasta 8 sonidos con nombre,
// color, muestra (incluida, de pack o propia), volumen y grupo de corte.
// Quitar un sonido que usan patrones avisa de cuántos.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DRUM_KIT_MAX_SOUNDS, type DrumKit, type DrumSound, type LoopPattern } from "@libretracks/shared/models";

import { SamplePicker } from "./SamplePicker";

/** Patrones de la biblioteca que usan `soundId` de este kit. */
export function patternsUsingSound(kit: DrumKit, soundId: string, patterns: LoopPattern[]): number {
  return patterns.filter(
    (p) => p.kit.kind === "library" && p.kit.kitId === kit.id && p.rows.some((r) => r.soundId === soundId),
  ).length;
}

type KitEditorProps = {
  kit: DrumKit;
  patterns: LoopPattern[];
  onSave: (kit: DrumKit) => Promise<void> | void;
  onClose: () => void;
  confirm?: (message: string) => boolean;
  pickPath?: () => Promise<string | null>;
};

export function KitEditor({ kit: initial, patterns, onSave, onClose, confirm, pickPath }: KitEditorProps) {
  const { t } = useTranslation();
  const [kit, setKit] = useState(initial);

  const updateSound = (index: number, patch: Partial<DrumSound>) =>
    setKit((k) => ({ ...k, sounds: k.sounds.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));

  const remove = (index: number) => {
    const sound = kit.sounds[index];
    const used = patternsUsingSound(initial, sound.id, patterns);
    if (used > 0) {
      const message = t("rhythm.kit.removeUsed", { name: sound.name, count: used });
      if (!(confirm ? confirm(message) : window.confirm(message))) return;
    }
    setKit((k) => ({ ...k, sounds: k.sounds.filter((_, i) => i !== index) }));
  };

  const add = () =>
    setKit((k) =>
      k.sounds.length >= DRUM_KIT_MAX_SOUNDS
        ? k
        : {
            ...k,
            sounds: [
              ...k.sounds,
              {
                id: `sound-${Date.now().toString(36)}-${k.sounds.length}`,
                name: t("rhythm.kit.newSound", { number: k.sounds.length + 1 }),
                color: "#57f1db",
                sample: { source: { kind: "builtin" }, file: "" },
                gainDb: 0,
              },
            ],
          },
    );

  return (
    <div className="lt-rhythm-backdrop">
    <div className="lt-rhythm-card lt-kit-editor" role="dialog" aria-label={t("rhythm.kit.title")} data-testid="kit-editor">
      <div className="lt-loop-editor__header">
        <input
          className="lt-loop-editor__name"
          aria-label={t("rhythm.kit.name")}
          value={kit.name}
          onChange={(event) => setKit({ ...kit, name: event.target.value })}
        />
        <span className="lt-rhythm-header__spacer" />
        <button type="button" onClick={onClose}>
          {t("rhythm.pads.cancel")}
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={async () => {
            await onSave(kit);
            onClose();
          }}
        >
          {t("rhythm.editor.save")}
        </button>
      </div>
      <div className="lt-kit-editor__sounds">
        {kit.sounds.map((sound, index) => (
          <div key={sound.id} className="lt-kit-editor__sound" data-testid={`kit-sound-${index}`}>
            <input
              type="color"
              aria-label={t("rhythm.pads.color")}
              value={sound.color || "#57f1db"}
              onChange={(event) => updateSound(index, { color: event.target.value })}
            />
            <input
              aria-label={t("rhythm.pads.name")}
              value={sound.name}
              onChange={(event) => updateSound(index, { name: event.target.value })}
            />
            <SamplePicker
              kind="loop"
              value={sound.sample.file ? sound.sample : null}
              pickPath={pickPath}
              onPick={(sample) => updateSound(index, { sample })}
            />
            <input
              type="range"
              aria-label={t("rhythm.volume")}
              min={-24}
              max={6}
              step={0.5}
              value={sound.gainDb}
              onChange={(event) => updateSound(index, { gainDb: Number(event.target.value) })}
            />
            <select
              aria-label={t("rhythm.pads.choke")}
              value={sound.chokeGroup ?? 0}
              onChange={(event) => {
                const group = Number(event.target.value);
                updateSound(index, { chokeGroup: group > 0 ? group : null });
              }}
            >
              {[0, 1, 2, 3, 4].map((group) => (
                <option key={group} value={group}>
                  {group === 0 ? t("rhythm.pads.noChoke") : group}
                </option>
              ))}
            </select>
            <button type="button" aria-label={t("rhythm.kit.remove", { name: sound.name })} onClick={() => remove(index)}>
              ×
            </button>
          </div>
        ))}
        <button type="button" disabled={kit.sounds.length >= DRUM_KIT_MAX_SOUNDS} onClick={add}>
          {t("rhythm.kit.add")}
        </button>
      </div>
    </div>
    </div>
  );
}
