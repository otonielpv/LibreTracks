import { useCallback, useEffect, useRef } from "react";
import type { ChangeEvent } from "react";

/**
 * Fine-drag for a native `<input type=range>` fader.
 *
 * A native range input snaps to the *absolute* pointer position, so there's no
 * built-in way to slow it down for precise adjustments. Two things make this
 * awkward:
 *
 *  1. Intercepting with pointer events doesn't work — the browser runs the
 *     slider's own drag before a React (bubble-phase) `preventDefault` can stop
 *     it, so the native change still fires with the absolute value.
 *  2. The `change`/`input` event a range fires does **not** carry `shiftKey`
 *     (it's not a mouse/key event), so we can't read the modifier off it.
 *
 * So we (a) track Shift globally via window key listeners — the same trick the
 * compact mixer uses — and (b) work *with* the native `onChange`: while Shift is
 * held we apply only a fraction ({@link FINE_DRAG_FACTOR}) of the *increment*
 * the input reports since the last event, giving the Reaper-style crawl. The
 * input is controlled (its `value` is the fine position), so the thumb tracks
 * the fine value; we remember the raw native value to measure the next step.
 *
 * The value space is fader *position* in `[0, 1]`; the caller converts to gain.
 */
export const FINE_DRAG_FACTOR = 0.25;

export function useFineDragRange(options: {
  /** Current fader position [0,1] (the controlled `value`). */
  value: number;
  onChange: (nextPosition: number) => void;
  onCommit: () => void;
}) {
  const { onChange, onCommit } = options;

  const valueRef = useRef(options.value);
  valueRef.current = options.value;

  // Shift state, tracked globally because the range's change event can't tell
  // us whether a modifier is down.
  const shiftPressedRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftPressedRef.current = false;
    };
    // If focus leaves the window mid-drag we'd never see the keyup.
    const onBlur = () => {
      shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // The raw native slider value at the previous change event; null = no active
  // fine-drag baseline.
  const lastNativeRef = useRef<number | null>(null);
  const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

  // Reset the fine-drag baseline whenever a fresh press starts, so the first
  // Shift change establishes the anchor (zero net move) instead of jumping.
  const handlePointerDown = useCallback(() => {
    lastNativeRef.current = null;
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nativeValue = Number(event.target.value);

      if (!shiftPressedRef.current) {
        // Normal drag: pass the value straight through, drop any baseline.
        lastNativeRef.current = null;
        onChange(clamp01(nativeValue));
        return;
      }

      // First Shift change of this drag: anchor here, emit nothing (no jump).
      if (lastNativeRef.current == null) {
        lastNativeRef.current = nativeValue;
        return;
      }

      // Apply only a fraction of the increment since the last native value.
      const nativeDelta = nativeValue - lastNativeRef.current;
      lastNativeRef.current = nativeValue;
      const next = valueRef.current + nativeDelta * FINE_DRAG_FACTOR;
      onChange(clamp01(next));
    },
    [onChange],
  );

  const handleCommit = useCallback(() => {
    lastNativeRef.current = null;
    onCommit();
  }, [onCommit]);

  return { handleChange, handlePointerDown, handleCommit };
}
