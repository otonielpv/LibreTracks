// Editor de un pad de one shot (plan drum-loops, paso 09): muestra, nombre,
// color, volumen, modo, cuantización y grupo de corte; renombrar el banco.
// Popover en wide/medium, hoja a pantalla completa en short.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { OneShotPad, OneShotSet } from "@libretracks/shared/models";

import { ensureBank, renameBank, setPad } from "./oneShotOps";
import { SamplePicker } from "./SamplePicker";
import type { RhythmLayoutClass } from "./useRhythmLayout";

type OneShotPadEditorProps = {
  set: OneShotSet;
  bankIndex: number;
  padIndex: number;
  layoutClass: RhythmLayoutClass;
  onSave: (set: OneShotSet) => Promise<void> | void;
  onClose: () => void;
  pickPath?: () => Promise<string | null>;
};

export function OneShotPadEditor({
  set,
  bankIndex,
  padIndex,
  layoutClass,
  onSave,
  onClose,
  pickPath,
}: OneShotPadEditorProps) {
  const { t } = useTranslation();
  const bank = ensureBank(set, bankIndex).banks[bankIndex];
  const existing = bank.pads[padIndex] ?? null;
  const [pad, setPadDraft] = useState<OneShotPad | null>(existing);
  const [bankName, setBankName] = useState(bank.name);
  const sheet = layoutClass === "short";

  const update = (patch: Partial<OneShotPad>) => setPadDraft((p) => (p ? { ...p, ...patch } : p));

  const save = async () => {
    let next = setPad(set, bankIndex, padIndex, pad);
    if (bankName.trim() && bankName !== bank.name) next = renameBank(next, bankIndex, bankName.trim());
    await onSave(next);
    onClose();
  };

  return (
    <div
      className={sheet ? "lt-pad-editor is-sheet" : "lt-pad-editor is-popover"}
      role="dialog"
      aria-label={t("rhythm.pads.editTitle", { number: padIndex + 1 })}
      data-testid="pad-editor"
      data-variant={sheet ? "sheet" : "popover"}
    >
      <label className="lt-rhythm-field">
        <span>{t("rhythm.pads.bankName")}</span>
        <input value={bankName} onChange={(event) => setBankName(event.target.value)} />
      </label>
      <SamplePicker
        kind="oneShot"
        value={pad?.sample ?? null}
        pickPath={pickPath}
        onPick={(sample, name) =>
          setPadDraft((p) =>
            p
              ? { ...p, sample }
              : {
                  id: `pad-${bankIndex}-${padIndex}-${Date.now().toString(36)}`,
                  name,
                  color: "#57f1db",
                  sample,
                  gainDb: 0,
                  mode: "oneShot",
                  quantize: "off",
                },
          )
        }
      />
      {pad ? (
        <>
          <label className="lt-rhythm-field">
            <span>{t("rhythm.pads.name")}</span>
            <input value={pad.name} onChange={(event) => update({ name: event.target.value })} />
          </label>
          <label className="lt-rhythm-field">
            <span>{t("rhythm.pads.color")}</span>
            <input type="color" value={pad.color || "#57f1db"} onChange={(event) => update({ color: event.target.value })} />
          </label>
          <label className="lt-rhythm-field">
            <span>{t("rhythm.volume")}</span>
            <input
              type="range"
              min={-24}
              max={6}
              step={0.5}
              value={pad.gainDb}
              onChange={(event) => update({ gainDb: Number(event.target.value) })}
            />
          </label>
          <label className="lt-rhythm-field">
            <span>{t("rhythm.pads.mode")}</span>
            <select value={pad.mode} onChange={(event) => update({ mode: event.target.value as OneShotPad["mode"] })}>
              <option value="oneShot">{t("rhythm.pads.oneShot")}</option>
              <option value="gate">{t("rhythm.pads.gate")}</option>
            </select>
          </label>
          <label className="lt-rhythm-field">
            <span>{t("rhythm.quantize")}</span>
            <select
              value={pad.quantize}
              onChange={(event) => update({ quantize: event.target.value as OneShotPad["quantize"] })}
            >
              <option value="off">{t("rhythm.quantizeImmediate")}</option>
              <option value="beat">{t("rhythm.quantizeBeat")}</option>
              <option value="bar">{t("rhythm.quantizeBar")}</option>
            </select>
          </label>
          <label className="lt-rhythm-field">
            <span>{t("rhythm.pads.choke")}</span>
            <select
              value={pad.chokeGroup ?? 0}
              onChange={(event) => {
                const group = Number(event.target.value);
                update({ chokeGroup: group > 0 ? group : null });
              }}
            >
              {[0, 1, 2, 3, 4].map((group) => (
                <option key={group} value={group}>
                  {group === 0 ? t("rhythm.pads.noChoke") : group}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setPadDraft(null)}>
            {t("rhythm.pads.clear")}
          </button>
        </>
      ) : null}
      <div className="lt-pad-editor__actions">
        <button type="button" onClick={onClose}>
          {t("rhythm.pads.cancel")}
        </button>
        <button type="button" className="is-primary" onClick={() => void save()}>
          {t("rhythm.editor.save")}
        </button>
      </div>
    </div>
  );
}
