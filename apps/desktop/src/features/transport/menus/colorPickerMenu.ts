import type { ContextMenuAction } from "../types";
import {
  TIMELINE_COLOR_PRESETS,
} from "../colors/timelineColors";

export type ColorPickerMenuArgs = {
  title: string;
  currentColor?: string | null;
  onColor: (color: string | null) => Promise<void>;
  recordRecentColor: (color: string | null) => void;
  openCustomColorPopover: (
    title: string,
    initialColor: string | null | undefined,
    onColor: (color: string) => Promise<void>,
  ) => void;
};

/**
 * The colour vocabulary of every "select colour" menu: the presets, the custom
 * popover and "remove colour".
 *
 * Single funnel: every applied non-null colour is recorded as "recent" here, so
 * the popover's Recientes row stays in sync regardless of the entry point
 * (preset, custom popover, or recent swatch).
 */
export function colorPickerActions({
  title,
  currentColor,
  onColor,
  recordRecentColor,
  openCustomColorPopover,
}: ColorPickerMenuArgs): ContextMenuAction[] {
  const applyColor = async (color: string | null) => {
    recordRecentColor(color);
    await onColor(color);
  };

  return [
    ...TIMELINE_COLOR_PRESETS.map((preset) => ({
      label: `${preset.label}${currentColor === preset.value ? " (actual)" : ""}`,
      swatch: preset.value,
      onSelect: () => applyColor(preset.value),
    })),
    {
      label: "Personalizado...",
      swatch: currentColor ?? "#3CDDC7",
      onSelect: () =>
        openCustomColorPopover(title, currentColor, (color) =>
          applyColor(color),
        ),
    },
    {
      label: "Quitar color",
      disabled: !currentColor,
      onSelect: () => onColor(null),
    },
  ];
}
