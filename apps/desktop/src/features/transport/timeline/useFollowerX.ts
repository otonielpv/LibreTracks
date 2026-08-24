import { useEffect, useRef } from "react";

/**
 * Elemento absoluto cuya posición horizontal la manda un ref, no React.
 *
 * Lo usan las guías y los indicadores que siguen al puntero durante un
 * arrastre: su posición depende de la cámara y del zoom **vivos** (que cambian
 * sin re-render) y se actualiza en cada movimiento. Cuando esa posición vivía
 * en `useState`, cada `pointermove` costaba un render completo del panel del
 * timeline — 144 por segundo en una pantalla de 144 Hz, medido
 * (docs/plans/ui-performance/state/01.md).
 *
 * Dos decisiones que no son casuales:
 *
 * - El elemento se queda **siempre montado** y se oculta con `display`. Montar
 *   y desmontar exigiría un render por gesto, que es justo lo que esto viene a
 *   quitar.
 * - La posición viaja por **`transform`**, no por `left`: `left` invalida
 *   layout y esto corre en cada frame.
 *
 * @param resolve Devuelve la X en píxeles, o `null` para ocultar. Se lee a
 *   través de un espejo en ref, así que cambiar su identidad entre renders no
 *   re-suscribe el bucle a mitad de un arrastre.
 */
export function useFollowerX(resolve: () => number | null) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  useEffect(() => {
    let animationFrameId = 0;
    let lastX = Number.NaN;
    let lastVisible: boolean | null = null;

    const sync = () => {
      const element = elementRef.current;
      if (element) {
        const x = resolveRef.current();
        const visible = x !== null;
        if (visible !== lastVisible) {
          element.style.display = visible ? "block" : "none";
          lastVisible = visible;
        }
        if (x !== null && x !== lastX) {
          element.style.transform = `translateX(${x}px)`;
          lastX = x;
        }
      }

      animationFrameId = window.requestAnimationFrame(sync);
    };

    animationFrameId = window.requestAnimationFrame(sync);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, []);

  return elementRef;
}
