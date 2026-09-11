// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createTimelineVerticalScroller } from "./timelineVerticalScroll";

function viewport(options: { scrollHeight: number; clientHeight: number }) {
  let scrollTop = 0;
  const reads = vi.fn();
  return {
    reads,
    get scrollTopValue() {
      return scrollTop;
    },
    element: {
      get scrollTop() {
        reads();
        return scrollTop;
      },
      set scrollTop(next: number) {
        scrollTop = next;
      },
      scrollHeight: options.scrollHeight,
      clientHeight: options.clientHeight,
    } as unknown as HTMLElement,
  };
}

describe("desplazamiento vertical tactil del timeline", () => {
  it("lleva su propio objetivo: no lee el desplazamiento por muestra", () => {
    const v = viewport({ scrollHeight: 1000, clientHeight: 400 });
    const scroller = createTimelineVerticalScroller(() => v.element);

    scroller.seed();
    const readsAfterSeed = v.reads.mock.calls.length;
    scroller.scrollBy(10);
    scroller.scrollBy(10);
    scroller.scrollBy(10);

    expect(v.scrollTopValue).toBe(30);
    expect(v.reads.mock.calls.length).toBe(readsAfterSeed);
  });

  // La razon de ser del acumulador: en WKWebView `scrollTop` puede devolver un
  // valor anterior a la escritura del movimiento anterior, y con `+=` cada
  // lectura rancia se come el recorrido acumulado desde ella.
  it("no pierde recorrido aunque el DOM devuelva un desplazamiento rancio", () => {
    const v = viewport({ scrollHeight: 1000, clientHeight: 400 });
    const scroller = createTimelineVerticalScroller(() => v.element);
    scroller.seed();
    scroller.scrollBy(10);
    // El contenedor "se queda atras": la escritura aun no ha aterrizado.
    v.element.scrollTop = 0;

    scroller.scrollBy(10);

    expect(v.scrollTopValue).toBe(20);
  });

  it("se queda dentro del recorrido posible", () => {
    const v = viewport({ scrollHeight: 1000, clientHeight: 400 });
    const scroller = createTimelineVerticalScroller(() => v.element);
    scroller.seed();

    scroller.scrollBy(5000);
    expect(v.scrollTopValue).toBe(600);
    scroller.scrollBy(-5000);
    expect(v.scrollTopValue).toBe(0);
  });

  it("vuelve a sincronizarse con el DOM en cada anclaje", () => {
    const v = viewport({ scrollHeight: 1000, clientHeight: 400 });
    const scroller = createTimelineVerticalScroller(() => v.element);
    scroller.seed();
    scroller.scrollBy(30);

    // Lo mueve otro (seguimiento del cabezal, rueda, barra lateral).
    v.element.scrollTop = 500;
    scroller.seed();
    scroller.scrollBy(10);

    expect(v.scrollTopValue).toBe(510);
  });

  it("aguanta sin contenedor", () => {
    const scroller = createTimelineVerticalScroller(() => null);
    expect(() => {
      scroller.seed();
      scroller.scrollBy(10);
    }).not.toThrow();
  });
});
