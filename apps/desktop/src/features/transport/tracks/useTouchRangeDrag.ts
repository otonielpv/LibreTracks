import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Arrastre tactil para un `<input type=range>`.
 *
 * WebKit en iOS solo mueve el pulgar si el dedo aterriza ENCIMA de el: tocar el
 * riel no hace nada. Con un pulgar de 9 px eso es una punteria que nadie tiene
 * con el dedo, y es literalmente el "cuesta mucho cogerlos". Ademas, el
 * arrastre nativo lo lleva el navegador, que a los pocos pixeles verticales
 * decide que el gesto era un desplazamiento, cancela el puntero y suelta el
 * fader mientras la vista entera se va detras del dedo.
 *
 * Asi que el gesto tactil lo llevamos nosotros: el valor sale de DONDE esta el
 * dedo sobre el riel —tocar ya coloca—, y el puntero queda capturado hasta que
 * se levanta. El raton no se toca: ahi el control nativo va bien y arrastra
 * como siempre (incluido el ajuste fino con Shift, ver useFineDragRange).
 *
 * El gesto necesita ademas `touch-action: none` en el propio input, o el
 * navegador se queda con la parte vertical antes de que llegue el primer
 * `pointermove`.
 */
export function rangeValueAtPointer(
  clientX: number,
  bounds: { left: number; width: number },
  min: number,
  max: number,
  step: number,
): number {
  if (!(bounds.width > 0) || !(max > min)) {
    return min;
  }
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  const raw = min + ratio * (max - min);
  if (!(step > 0)) {
    return raw;
  }
  const snapped = min + Math.round((raw - min) / step) * step;
  // El paso puede no dividir el recorrido en partes enteras (0.001 en [0,1] si,
  // pero 0.01 en [-1,1] tambien tiene que llegar a los topes exactos).
  return Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
}

export function useTouchRangeDrag(options: {
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;

  return useCallback((event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    const input = event.currentTarget;
    const pointerId = event.pointerId;
    // Se le quita el gesto al control nativo ANTES de que empiece: ya no hay
    // arrastre del navegador, ni eventos de raton de compatibilidad detras.
    event.preventDefault();
    event.stopPropagation();

    const bounds = input.getBoundingClientRect();
    const apply = (clientX: number) => {
      const { min, max, step, onChange } = latest.current;
      onChange(rangeValueAtPointer(clientX, bounds, min, max, step));
    };

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (moveEvent.cancelable) moveEvent.preventDefault();
      apply(moveEvent.clientX);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      try {
        if (input.hasPointerCapture?.(pointerId)) {
          input.releasePointerCapture(pointerId);
        }
      } catch {
        // El puntero ya no existe: no hay nada que liberar.
      }
      latest.current.onCommit();
    };

    apply(event.clientX);
    try {
      input.setPointerCapture?.(pointerId);
    } catch {
      // Sin captura el gesto sigue vivo: las escuchas van en `window`.
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);
}
