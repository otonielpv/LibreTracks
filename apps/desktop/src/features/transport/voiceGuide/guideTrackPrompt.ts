import { create } from "zustand";

import type { AppSettings, SongView } from "@libretracks/shared/models";

/**
 * Aviso de «falta la pista de guía» (voz guía «solo en saltos»). Con la opción
 * encendida el motor silencia la guía de la secuencia mientras la voz anuncia
 * un salto; una canción sin pista de guía detectada (ni elegida) sonaría con
 * las dos voces encima, así que se avisa y se deja elegirla.
 *
 * `dismissed` son las canciones de las que el usuario ya dijo «Ahora no»: no
 * se vuelve a avisar por ellas hasta que apague y encienda la opción o lo pida
 * desde la voz guía. Vive en un store porque lo leen el aviso y los controles
 * de la voz guía (ver testUtils, que lo resetea).
 */
type GuideTrackPromptStore = {
  dismissed: string[];
  /** El usuario pidió verlo (botón «Elegir» de la voz guía). */
  forced: boolean;
  dismiss: (regionIds: readonly string[]) => void;
  reopen: () => void;
  reset: () => void;
};

export const INITIAL_GUIDE_TRACK_PROMPT_STATE = { dismissed: [] as string[], forced: false };

export const useGuideTrackPromptStore = create<GuideTrackPromptStore>()((set) => ({
  ...INITIAL_GUIDE_TRACK_PROMPT_STATE,
  dismiss: (regionIds) =>
    set((state) => ({
      forced: false,
      dismissed: [...new Set([...state.dismissed, ...regionIds])],
    })),
  reopen: () => set({ dismissed: [], forced: true }),
  reset: () => set({ ...INITIAL_GUIDE_TRACK_PROMPT_STATE }),
}));

/** Si la voz guía está en «solo en saltos» (y encendida). */
export function guideJumpsOnlyActive(
  settings: Pick<AppSettings, "voiceGuideEnabled" | "voiceGuideJumpsOnly">,
): boolean {
  return settings.voiceGuideEnabled && settings.voiceGuideJumpsOnly;
}

/** Canciones sin pista de guía. Una sin el dato (`undefined`) no cuenta. */
export function regionsMissingGuide(song: SongView | null) {
  return (song?.regions ?? []).filter((region) => region.hasGuideTrack === false);
}
