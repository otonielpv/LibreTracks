import { useEffect, useState } from "react";

import type { EqPreset } from "@libretracks/shared/models";

import { listEqPresets } from "../desktopApi";

/**
 * La lista de presets de EQ de esta máquina para quien solo la lee (escenas,
 * cues). Se pide al montar; si falla queda vacía. El editor de EQ tiene su
 * propio desplegable, que la vuelve a leer al abrirse.
 */
export function useEqPresets(): EqPreset[] {
  const [presets, setPresets] = useState<EqPreset[]>([]);
  useEffect(() => {
    let cancelled = false;
    listEqPresets()
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return presets;
}

/** El nombre a mostrar: los de fábrica se traducen por id. */
export function eqPresetLabel(
  preset: EqPreset,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return preset.factory
    ? t(`eq.presets.names.${preset.id}`, { defaultValue: preset.name })
    : preset.name;
}
