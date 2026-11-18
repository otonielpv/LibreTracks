// Los editores que abre el panel (✎): patrón (paso 08) y pads (paso 09).
// Una sola definición de guardar para todas las vistas (D14).
import type { AppSettings, DrumKit, LoopPattern, RegionLoop } from "@libretracks/shared/models";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { assignLoopToSong, deleteDrumKit, saveDrumKit, saveLoopPattern, saveOneShotSet, setActivePattern } from "../desktopApi";
import { blankKit, KitEditor } from "./KitEditor";
import { LoopEditor, type LoopEditorSaveTarget } from "./LoopEditor";
import { OneShotPadEditor } from "./OneShotPadEditor";
import { emptyPattern } from "./patternOps";
import type { RhythmEditTarget } from "./RhythmPanel";
import { useRhythmStore } from "./rhythmStore";
import type { RhythmLayoutClass } from "./useRhythmLayout";

export function kitForPattern(pattern: LoopPattern, kits: DrumKit[]): DrumKit | null {
  const ref = pattern.kit;
  if (ref.kind === "embedded") return ref.kit;
  return kits.find((k) => k.id === ref.kitId) ?? null;
}

/** El patrón que edita ✎: el de la canción, el activo o uno vacío nuevo. */
export function patternToEdit(
  settings: AppSettings,
  songLoop: RegionLoop | null | undefined,
  patterns: LoopPattern[],
  kits: DrumKit[],
  newId: () => string = () => `pattern-${Date.now().toString(36)}`,
): { pattern: LoopPattern; kit: DrumKit } | null {
  const existing = songLoop?.pattern ?? patterns.find((p) => p.id === settings.activeLoopPatternId) ?? null;
  if (existing) {
    const kit = kitForPattern(existing, kits);
    return kit ? { pattern: existing, kit } : null;
  }
  const kit = kits[0];
  if (!kit) return null;
  return { pattern: emptyPattern(newId(), kit.name, kit, { kind: "library", kitId: kit.id }), kit };
}

type RhythmEditorsProps = {
  target: RhythmEditTarget | null;
  settings: AppSettings;
  onSettings: (settings: AppSettings) => void;
  songLoop?: RegionLoop | null;
  songRegionId?: string | null;
  layoutClass: RhythmLayoutClass;
  onClose: () => void;
};

export function RhythmEditors({
  target,
  settings,
  onSettings,
  songLoop,
  songRegionId,
  layoutClass,
  onClose,
}: RhythmEditorsProps) {
  const library = useRhythmStore((s) => s.library);
  const setLibrary = useRhythmStore((s) => s.setLibrary);
  if (!target || !library) return null;

  if (target.kind === "pad") {
    return (
      <OneShotPadEditor
        set={library.oneShots}
        bankIndex={Math.min(settings.activeOneShotBank, 3)}
        padIndex={target.pad}
        layoutClass={layoutClass}
        onSave={async (set) => setLibrary(await saveOneShotSet(set))}
        onClose={onClose}
      />
    );
  }

  if (target.kind === "pattern") {
    return (
      <PatternEditors
        settings={settings}
        onSettings={onSettings}
        songLoop={songLoop}
        songRegionId={songRegionId}
        layoutClass={layoutClass}
        onClose={onClose}
      />
    );
  }
  return null;
}

type PatternEditorsProps = Omit<RhythmEditorsProps, "target">;

/** Editor de patrón + editor de su kit. El patrón se elige UNA vez al abrir:
 * si se recalculase en cada render, un patrón nuevo cogería `kits[0]`, y
 * guardar un kit de serie lo manda al final de la lista (la copia del usuario
 * va detrás de los de serie), así que el editor saltaba a otro kit. El kit se
 * busca siempre por el id que referencia el patrón. */
function PatternEditors({ settings, onSettings, songLoop, songRegionId, layoutClass, onClose }: PatternEditorsProps) {
  const library = useRhythmStore((s) => s.library);
  const setLibrary = useRhythmStore((s) => s.setLibrary);
  const { t } = useTranslation();
  const [kitEdit, setKitEdit] = useState<{ kit: DrumKit; isNew: boolean; select: (kit: DrumKit) => void } | null>(
    null,
  );
  const [initial] = useState(() =>
    library ? patternToEdit(settings, songLoop, library.patterns, library.kits) : null,
  );
  if (!library || !initial) return null;
  const kit = kitForPattern(initial.pattern, library.kits) ?? initial.kit;
  const save = async (pattern: LoopPattern, where: LoopEditorSaveTarget) => {
    if (where === "song" && songRegionId) {
      await assignLoopToSong(songRegionId, pattern);
      return;
    }
    setLibrary(await saveLoopPattern(pattern));
    if (where === "new" || !settings.activeLoopPatternId) onSettings(await setActivePattern(pattern.id));
  };
  return (
    <>
      <LoopEditor
        pattern={initial.pattern}
        kit={kit}
        kits={library.kits}
        layoutClass={layoutClass}
        songRegionId={songRegionId}
        onSave={save}
        onClose={onClose}
        onEditKit={(toEdit, select) =>
          setKitEdit({
            kit: toEdit ?? blankKit(t("rhythm.kit.newName")),
            isNew: toEdit === null,
            select,
          })
        }
      />
      {kitEdit ? (
        <KitEditor
          kit={kitEdit.kit}
          isNew={kitEdit.isNew}
          patterns={library.patterns}
          onSave={async (saved) => {
            setLibrary(await saveDrumKit(saved));
            // Un kit nuevo (creado o «Guardar como nuevo») pasa al patrón.
            if (saved.id !== kitEdit.kit.id || kitEdit.isNew) kitEdit.select(saved);
          }}
          onClose={() => setKitEdit(null)}
          deleteMode={kitDeleteMode(kitEdit.kit.id, kitEdit.isNew, library)}
          onDelete={async () => {
            const mode = kitDeleteMode(kitEdit.kit.id, kitEdit.isNew, library);
            const next = await deleteDrumKit(kitEdit.kit.id);
            setLibrary(next);
            // Eliminado del todo: el patrón abierto pasa al primer kit que queda.
            if (mode === "delete" && next.kits[0]) kitEdit.select(next.kits[0]);
          }}
        />
      ) : null}
    </>
  );
}

/** Qué hace «borrar» con este kit, o nada si no es del usuario. */
export function kitDeleteMode(
  kitId: string,
  isNew: boolean,
  library: { ownKitIds?: string[]; shippedKitIds?: string[] },
): "delete" | "restore" | undefined {
  if (isNew || !library.ownKitIds?.includes(kitId)) return undefined;
  return library.shippedKitIds?.includes(kitId) ? "restore" : "delete";
}
