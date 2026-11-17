// Los editores que abre el panel (✎): patrón (paso 08) y pads (paso 09).
// Una sola definición de guardar para todas las vistas (D14).
import type { AppSettings, DrumKit, LoopPattern, RegionLoop } from "@libretracks/shared/models";

import { useState } from "react";

import { assignLoopToSong, saveDrumKit, saveLoopPattern, saveOneShotSet, setActivePattern } from "../desktopApi";
import { KitEditor } from "./KitEditor";
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
  const [kitOpen, setKitOpen] = useState(false);
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
    const editable = patternToEdit(settings, songLoop, library.patterns, library.kits);
    if (!editable) return null;
    const save = async (pattern: LoopPattern, where: LoopEditorSaveTarget) => {
      if (where === "song" && songRegionId) {
        await assignLoopToSong(songRegionId, pattern);
        return;
      }
      setLibrary(await saveLoopPattern(pattern));
      if (where === "new" || !settings.activeLoopPatternId) onSettings(await setActivePattern(pattern.id));
    };
    const libraryKit = library.kits.find((k) => k.id === editable.kit.id) ?? null;
    return (
      <>
        <LoopEditor
          pattern={editable.pattern}
          kit={editable.kit}
          layoutClass={layoutClass}
          songRegionId={songRegionId}
          onSave={save}
          onClose={onClose}
          onEditKit={libraryKit ? () => setKitOpen(true) : undefined}
        />
        {kitOpen && libraryKit ? (
          <KitEditor
            kit={libraryKit}
            patterns={library.patterns}
            onSave={async (kit) => setLibrary(await saveDrumKit(kit))}
            onClose={() => setKitOpen(false)}
          />
        ) : null}
      </>
    );
  }
  return null;
}
