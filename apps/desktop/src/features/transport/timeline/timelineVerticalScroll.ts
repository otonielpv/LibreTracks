import { boundedTimelineScrollTop } from "./useBoundedTimelineScroll";

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
 *
 * El tope NO sale de `scrollHeight`: en WKWebView las rebanadas de lienzo,
 * absolutas, se cuelan en el desbordamiento del contenedor y lo hacen mas alto
 * que la escena. Acotando con el, el gesto se iba por debajo del final —negro y
 * sin frenar— y la correccion de useBoundedTimelineScroll tiraba en sentido
 * contrario en cada evento de scroll. El alto de verdad lo sabe quien pinta:
 * regla + escena de pistas.
 */
export type TimelineVerticalScroller = {
  /** Re-sincroniza con el DOM. Se llama al (re)anclar el gesto, no por muestra. */
  seed: () => void;
  scrollBy: (delta: number) => void;
};

export function createTimelineVerticalScroller(
  getViewport: () => HTMLElement | null,
  /** Alto logico del contenido: la regla mas la escena de pistas. */
  getContentHeight: () => number,
): TimelineVerticalScroller {
  let target: number | null = null;
  let viewportHeight = 0;

  const seedFrom = (viewport: HTMLElement) => {
    viewportHeight = viewport.clientHeight;
    target = boundedTimelineScrollTop(
      viewport.scrollTop,
      viewportHeight,
      getContentHeight(),
    );
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
      const next = boundedTimelineScrollTop(
        (target ?? 0) + delta,
        viewportHeight,
        getContentHeight(),
      );
      target = next;
      viewport.scrollTop = next;
    },
  };
}
