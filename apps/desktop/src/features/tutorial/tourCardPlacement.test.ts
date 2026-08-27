import { describe, expect, it } from "vitest";

import { placeTourCard } from "./tourCardPlacement";

const VIEWPORT = { width: 1920, height: 1009 };
const CARD = { width: 368, height: 260 };

function overlapArea(
  position: { top: number; left: number },
  card: { width: number; height: number },
  target: { top: number; left: number; width: number; height: number },
): number {
  return (
    Math.max(
      0,
      Math.min(position.left + card.width, target.left + target.width) -
        Math.max(position.left, target.left),
    ) *
    Math.max(
      0,
      Math.min(position.top + card.height, target.top + target.height) -
        Math.max(position.top, target.top),
    )
  );
}

describe("colocación de la tarjeta de la guía", () => {
  it("sin objetivo, se centra en pantalla", () => {
    expect(placeTourCard(null, CARD, VIEWPORT)).toBeNull();
  });

  it("debajo de un botón con sitio de sobra", () => {
    const position = placeTourCard(
      { top: 100, left: 800, width: 140, height: 40 },
      CARD,
      VIEWPORT,
    );

    expect(position?.top).toBe(148);
    // Centrada sobre el botón.
    expect(position?.left).toBe(800 + 70 - 184);
  });

  it("encima cuando el control está pegado al fondo", () => {
    const position = placeTourCard(
      { top: 940, left: 800, width: 140, height: 40 },
      CARD,
      VIEWPORT,
    );

    expect(position?.top).toBe(940 - 8 - 260);
  });

  it("al lado de un panel que ocupa todo el alto", () => {
    // El panel de biblioteca: alto completo y estrecho. No cabe ni arriba ni
    // abajo, pero a la derecha sobra sitio, y ahí no tapa nada de lo que
    // explica.
    const position = placeTourCard(
      { top: 0, left: 0, width: 380, height: 1009 },
      CARD,
      VIEWPORT,
    );

    expect(position?.left).toBe(388);
  });

  it("minimiza el solapamiento cuando el objetivo no deja hueco entero", () => {
    // El modal de ajustes ocupa casi toda la ventana. Antes la tarjeta se
    // encajaba en la franja de 140px que quedaba debajo y el texto salía
    // reducido a una línea con scroll; centrada y entera se lee.
    const target = { top: 30, left: 60, width: 1800, height: 840 };
    const position = placeTourCard(target, CARD, VIEWPORT);

    expect(position).not.toBeNull();
    const centred = {
      top: (VIEWPORT.height - CARD.height) / 2,
      left: (VIEWPORT.width - CARD.width) / 2,
    };
    expect(overlapArea(position!, CARD, target)).toBeLessThan(
      overlapArea(centred, CARD, target),
    );
  });

  it("no se sale por los bordes al centrarse sobre el objetivo", () => {
    const nearLeft = placeTourCard(
      { top: 100, left: 4, width: 60, height: 40 },
      CARD,
      VIEWPORT,
    );
    expect(nearLeft?.left).toBe(12);

    const nearRight = placeTourCard(
      { top: 100, left: 1880, width: 30, height: 40 },
      CARD,
      VIEWPORT,
    );
    expect(nearRight?.left).toBe(VIEWPORT.width - CARD.width - 12);
  });

  it("prefiere debajo aunque a los lados sobre más espacio", () => {
    // Junto a un botón pequeño siempre hay más hueco a izquierda y derecha que
    // debajo. Irse allí manda la tarjeta a la otra punta de la pantalla y deja
    // de leerse como "esto explica eso", así que abajo gana mientras quepa.
    const position = placeTourCard(
      { top: 300, left: 900, width: 100, height: 40 },
      CARD,
      VIEWPORT,
    );

    expect(position?.top).toBe(348);
    expect(position?.left).toBe(900 + 50 - 184);
  });

  it("una ventana compacta conserva la tarjeta dentro de sus bordes", () => {
    const position = placeTourCard(
      { top: 100, left: 100, width: 100, height: 40 },
      CARD,
      { width: 420, height: 320 },
    );

    expect(position).toEqual({ top: 12, left: 40 });
  });

  it.each([
    ["teléfono vertical", { width: 360, height: 800 }],
    ["teléfono apaisado", { width: 800, height: 360 }],
    ["tablet", { width: 1024, height: 768 }],
    ["escritorio", { width: 1440, height: 900 }],
  ])("mantiene tarjeta y foco separados en %s", (_name, viewport) => {
    const card = {
      width: Math.min(368, viewport.width - 24),
      height: Math.min(245, viewport.height - 24),
    };
    const target = {
      top: viewport.height * 0.42,
      left: viewport.width * 0.12,
      width: viewport.width * 0.72,
      height: Math.max(44, viewport.height * 0.12),
    };
    const position = placeTourCard(target, card, viewport);

    expect(position).not.toBeNull();
    expect(position!.left).toBeGreaterThanOrEqual(12);
    expect(position!.top).toBeGreaterThanOrEqual(12);
    expect(position!.left + card.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(position!.top + card.height).toBeLessThanOrEqual(viewport.height - 12);
    const centred = {
      top: (viewport.height - card.height) / 2,
      left: (viewport.width - card.width) / 2,
    };
    expect(overlapArea(position!, card, target)).toBeLessThanOrEqual(
      overlapArea(centred, card, target),
    );
  });
});
