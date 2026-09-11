/**
 * Desplazamiento vertical del timeline mientras un dedo arrastra.
 *
 * Lo obvio —`viewport.scrollTop += delta`— obliga a LEER el desplazamiento
 * justo despues de haberlo escrito en el movimiento anterior, y leer
 * `scrollTop` vacia la cola de layout: con la escena de pistas colgando del
 * mismo contenedor, eso es un reflujo sincrono por cada `pointermove` —hasta
 * 120 por segundo en un iPhone con ProMotion—. Ademas, en WKWebView el
 * desplazamiento de un contenedor no siempre ha aterrizado cuando se vuelve a
 * leer, y cada lectura rancia se come el recorrido acumulado desde ella: el
 * carril se frena y luego pega un salto.
 *
 * Asi que el objetivo lo llevamos nosotros. Se siembra UNA vez por gesto con el
 * valor real del DOM y a partir de ahi solo se escribe.
 */
export type TimelineVerticalScroller = {
  /** Re-sincroniza con el DOM. Se llama al (re)anclar el gesto, no por muestra. */
  seed: () => void;
  scrollBy: (delta: number) => void;
};

export function createTimelineVerticalScroller(
  getViewport: () => HTMLElement | null,
): TimelineVerticalScroller {
  let target: number | null = null;
  let maxScrollTop = 0;

  const seedFrom = (viewport: HTMLElement) => {
    target = viewport.scrollTop;
    maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  };

  return {
    seed() {
      const viewport = getViewport();
      if (!viewport) {
        target = null;
        return;
      }
      seedFrom(viewport);
    },
    scrollBy(delta: number) {
      const viewport = getViewport();
      if (!viewport) {
        return;
      }
      if (target === null) {
        seedFrom(viewport);
      }
      const next = Math.min(maxScrollTop, Math.max(0, (target ?? 0) + delta));
      target = next;
      viewport.scrollTop = next;
    },
  };
}
