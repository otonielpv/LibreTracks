import type { ClipSummary, TransportSnapshot } from "@libretracks/shared/models";

import { promptDialog } from "../../../shared/dialog/dialogService";
import { updateClipFades } from "../desktopApi";
import { formatFadeSeconds, parseFadeSeconds } from "../songs/songFades";
import type { ContextMenuAction } from "../types";
import { sameCurve, sharedCurve, sharedFade, type FadeCurve } from "./clipFadeMath";

/** The curve presets the menu offers (control points), from Live's usual
 * shapes. Dragging the curve handle reaches everything in between. */
export const CLIP_FADE_CURVE_PRESETS: ReadonlyArray<{ key: string; curve: FadeCurve }> = [
  { key: "linear", curve: { x: 0.5, y: 0.5 } },
  { key: "fast", curve: { x: 0.1, y: 0.9 } },
  { key: "slow", curve: { x: 0.9, y: 0.1 } },
];

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type ClipFadeMenuDeps = {
  t: Translate;
  runAction: (action: () => Promise<void>) => Promise<unknown>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  /** Opens the curve presets as a nested menu. Without it (tests, callers
   * that don't nest) the curve items are left out. */
  openSubMenu?: (title: string, actions: ContextMenuAction[]) => void;
  /** Overridable in tests. */
  prompt?: (message: string, defaultValue: string) => Promise<string | null>;
  updateFades?: typeof updateClipFades;
};

/**
 * Items of the clip menu's "Fades ▸" submenu. They act on `clips` (the clicked
 * clip or the whole selection, the same list as the rest of the clip menu),
 * and each edit is one backend call, so one undo step for all of them.
 */
export function clipFadeMenuActions(
  clips: ClipSummary[],
  deps: ClipFadeMenuDeps,
): ContextMenuAction[] {
  const { t } = deps;
  const prompt = deps.prompt ?? promptDialog;
  const updateFades = deps.updateFades ?? updateClipFades;
  const ids = clips.map((clip) => clip.id);
  const fadeIn = sharedFade(clips, "in");
  const fadeOut = sharedFade(clips, "out");
  const hasAnyFade = clips.some(
    (clip) => (clip.fadeInSeconds ?? 0) > 0 || (clip.fadeOutSeconds ?? 0) > 0,
  );
  const shown = (value: number | null) =>
    value === null ? t("transport.menu.clipFadeMixed") : formatFadeSeconds(value);

  const commit = async (
    fadeInSeconds: number | null,
    fadeOutSeconds: number | null,
    curves: { fadeInCurve?: FadeCurve; fadeOutCurve?: FadeCurve } = {},
  ) => {
    await deps.runAction(async () => {
      deps.applyPlaybackSnapshot(await updateFades(ids, fadeInSeconds, fadeOutSeconds, curves));
      deps.setStatus(t("transport.status.clipFadesUpdated", { count: ids.length }));
    });
  };

  const edit = async (which: "in" | "out") => {
    const current = which === "in" ? fadeIn : fadeOut;
    const input = await prompt(
      t(which === "in" ? "transport.prompt.clipFadeIn" : "transport.prompt.clipFadeOut"),
      current === null ? "" : formatFadeSeconds(current),
    );
    if (input === null) return;
    // An empty field with mixed values means "leave them", not "remove".
    if (input.trim() === "" && current === null) return;
    const seconds = parseFadeSeconds(input);
    if (seconds === null) return;
    await commit(which === "in" ? seconds : null, which === "out" ? seconds : null);
  };

  const curveName = (curve: FadeCurve | null) => {
    if (curve === null) return t("transport.menu.clipFadeMixed");
    const preset = CLIP_FADE_CURVE_PRESETS.find((entry) => sameCurve(entry.curve, curve));
    return t(`transport.menu.clipFadeCurves.${preset?.key ?? "custom"}`);
  };
  const curveItem = (which: "in" | "out"): ContextMenuAction[] => {
    const openSubMenu = deps.openSubMenu;
    if (!openSubMenu) return [];
    const current = sharedCurve(clips, which);
    const title = t(which === "in" ? "transport.menu.clipFadeInCurve" : "transport.menu.clipFadeOutCurve", {
      name: curveName(current),
    });
    return [
      {
        label: `${title} ▸`,
        disabled: which === "in" ? fadeIn === 0 : fadeOut === 0,
        onSelect: () =>
          openSubMenu(
            title,
            CLIP_FADE_CURVE_PRESETS.map((preset) => ({
              label: t(`transport.menu.clipFadeCurves.${preset.key}`),
              disabled: current !== null && sameCurve(current, preset.curve),
              onSelect: () =>
                commit(
                  null,
                  null,
                  which === "in" ? { fadeInCurve: preset.curve } : { fadeOutCurve: preset.curve },
                ),
            })),
          ),
      },
    ];
  };

  return [
    {
      label: t("transport.menu.clipFadeIn", { seconds: shown(fadeIn) }),
      onSelect: () => edit("in"),
    },
    {
      label: t("transport.menu.clipFadeOut", { seconds: shown(fadeOut) }),
      onSelect: () => edit("out"),
    },
    ...curveItem("in"),
    ...curveItem("out"),
    {
      label: t("transport.menu.clipFadesRemove"),
      disabled: !hasAnyFade,
      onSelect: () => commit(0, 0),
    },
  ];
}
