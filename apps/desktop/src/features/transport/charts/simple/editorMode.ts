/** Which editor opens: the simple one (parts) or Advanced (ChordPro). The
 * last one used is remembered on this device. */
export type ChartEditorMode = "simple" | "advanced";

const MODE_KEY = "lt.chartEditor.mode";

export function readEditorMode(): ChartEditorMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "advanced" ? "advanced" : "simple";
  } catch {
    return "simple";
  }
}

export function storeEditorMode(mode: ChartEditorMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private mode: the choice just does not stick.
  }
}
