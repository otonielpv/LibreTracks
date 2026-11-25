import {
  VOICE_GUIDE_COUNT_STYLES,
  type SongRegionSummary,
  type TransportSnapshot,
  type VoiceGuideCountStyle,
} from "@libretracks/shared/models";

import { updateSongRegionVoiceGuideCountStyle } from "../desktopApi";
import type { ContextMenuAction } from "../types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SongCountStyleMenuDeps = {
  t: Translate;
  /** Global default, shown on the "follow the setting" entry. */
  globalCountStyle: VoiceGuideCountStyle;
  runAction: (action: () => Promise<void>) => Promise<unknown>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
};

/** Same accent the key submenu uses to tick the current choice. */
// Variable de tema: sigue al color de acento.
const CURRENT_SWATCH = "var(--lt-accent)";

const LABEL_KEYS: Record<VoiceGuideCountStyle, string> = {
  full: "transport.settingsModal.voiceGuideCountStyleFull",
  halfThenFull: "transport.settingsModal.voiceGuideCountStyleHalfThenFull",
  halfTime: "transport.settingsModal.voiceGuideCountStyleHalfTime",
};

/** Human label of a count style ("1-2-3-4", "1 · 2 · 1-2-3-4", ...). */
export function voiceGuideCountStyleLabel(
  t: Translate,
  style: VoiceGuideCountStyle,
): string {
  return t(LABEL_KEYS[style]);
}

/**
 * Items of the song's "Voice guide count-in ▸" submenu: follow the global
 * setting, or force one of the styles for this song. A song played at 140 BPM
 * counted "1 · 2 · 1 2 3 4" sits next to others counted plainly, so the choice
 * lives with the song (Playback does the same per section) while the global
 * setting is the default for every song that does not say otherwise.
 */
export function songCountStyleMenuActions(
  region: SongRegionSummary,
  deps: SongCountStyleMenuDeps,
): ContextMenuAction[] {
  const { t } = deps;
  const current = region.voiceGuideCountStyle ?? null;

  const apply = async (style: VoiceGuideCountStyle | null) => {
    if (style === current) return;
    await deps.runAction(async () => {
      const snapshot = await updateSongRegionVoiceGuideCountStyle(region.id, style);
      deps.applyPlaybackSnapshot(snapshot);
      deps.setStatus(
        t("transport.status.songCountStyleUpdated", {
          name: region.name,
          style: voiceGuideCountStyleLabel(t, style ?? deps.globalCountStyle),
        }),
      );
    });
  };

  return [
    {
      label: t("transport.menu.songCountStyleDefault", {
        style: voiceGuideCountStyleLabel(t, deps.globalCountStyle),
      }),
      swatch: current === null ? CURRENT_SWATCH : undefined,
      onSelect: () => apply(null),
    },
    ...VOICE_GUIDE_COUNT_STYLES.map((style) => ({
      label: voiceGuideCountStyleLabel(t, style),
      swatch: current === style ? CURRENT_SWATCH : undefined,
      onSelect: () => apply(style),
    })),
  ];
}
