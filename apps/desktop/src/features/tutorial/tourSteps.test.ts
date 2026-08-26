import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "../../shared/i18n/en";
import es from "../../shared/i18n/es";
import { SHORTCUT_ACTIONS } from "../transport/keyboard/actions";
import { visibleSteps, type TourPlatform } from "./tourModel";
import { TOURS } from "./tours";
import { TOUR_TARGETS, type TourTargetKey } from "./tourTargets";

/**
 * El contrato entre la guía y la UI real.
 *
 * La guía ilumina elementos por `data-lt-tour`, así que su punto débil es el
 * silencio: si alguien mueve un botón y su anclaje se va con él, la guía sigue
 * "funcionando" pero señala el vacío, y nadie se entera hasta que un usuario
 * abre la ayuda. Estos tests escanean las fuentes para que ese fallo salga
 * aquí.
 *
 * Es un test de acoplamiento a propósito: el precio de enseñar el control de
 * verdad en vez de una captura que envejece.
 */

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function collectComponentFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectComponentFiles(fullPath, found);
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      found.push(fullPath);
    }
  }
  return found;
}

// Los anclajes se escriben SIEMPRE como `data-lt-tour={TOUR_TARGETS.loQueSea}`,
// nunca con la cadena a pelo: así este escaneo puede cruzarlos con el catálogo
// y el editor autocompleta.
const ANCHOR_PATTERN = /data-lt-tour=\{TOUR_TARGETS\.(\w+)\}/g;

const renderedTargetKeys = new Set<string>();
for (const file of collectComponentFiles(srcRoot)) {
  for (const match of readFileSync(file, "utf8").matchAll(ANCHOR_PATTERN)) {
    renderedTargetKeys.add(match[1]);
  }
}

const targetKeyById = new Map<string, TourTargetKey>(
  Object.entries(TOUR_TARGETS).map(([key, id]) => [id, key as TourTargetKey]),
);

const allTours = Object.values(TOURS);
const allSteps = allTours.flatMap((tour) => tour.steps);
const shortcutActionIds = new Set(SHORTCUT_ACTIONS.map((action) => action.id));

function lookup(bundle: unknown, dottedKey: string): unknown {
  return dottedKey
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bundle,
    );
}

describe("anclajes de la guía", () => {
  it("cada paso apunta a un anclaje que la UI renderiza", () => {
    for (const step of allSteps) {
      if (!step.target) continue;
      const key = targetKeyById.get(step.target);
      expect(key, `${step.id}: destino desconocido "${step.target}"`).toBeDefined();
      expect(
        renderedTargetKeys.has(key as string),
        `El paso "${step.id}" ilumina TOUR_TARGETS.${key}, pero ningún ` +
          `componente lo renderiza. ¿Se movió o se borró ese control? El ` +
          `anclaje va donde esté ahora, no se quita del paso.`,
      ).toBe(true);
    }
  });

  it("no quedan anclajes muertos en el catálogo", () => {
    for (const key of Object.keys(TOUR_TARGETS)) {
      expect(
        renderedTargetKeys.has(key),
        `TOUR_TARGETS.${key} no lo renderiza nadie. Bórralo del catálogo o ` +
          `devuélvelo a su componente.`,
      ).toBe(true);
    }
  });
});

describe("textos de la guía", () => {
  for (const [language, bundle] of [
    ["es", es],
    ["en", en],
  ] as const) {
    it(`cada paso tiene título y cuerpo en ${language}`, () => {
      for (const step of allSteps) {
        expect(
          lookup(bundle, `${step.i18nKey}.title`),
          `Falta ${step.i18nKey}.title en ${language}.ts`,
        ).toBeTypeOf("string");
        expect(
          lookup(bundle, `${step.i18nKey}.body`),
          `Falta ${step.i18nKey}.body en ${language}.ts`,
        ).toBeTypeOf("string");
      }
    });
  }

  it("el texto alternativo de móvil está en los dos idiomas o en ninguno", () => {
    // Media traducción es peor que ninguna: i18next caería al `body` de
    // escritorio y un teléfono acabaría leyendo "arrastra" o "clic derecho".
    for (const step of allSteps) {
      const key = `${step.i18nKey}.bodyMobile`;
      expect(
        typeof lookup(es, key),
        `${key}: existe en un idioma y no en el otro`,
      ).toBe(typeof lookup(en, key));
    }
  });

  it("cada recorrido tiene nombre en los dos idiomas", () => {
    for (const tour of allTours) {
      expect(lookup(es, `${tour.i18nKey}.name`)).toBeTypeOf("string");
      expect(lookup(en, `${tour.i18nKey}.name`)).toBeTypeOf("string");
    }
  });
});

describe("recorridos", () => {
  it("los atajos citados existen en el registro de acciones", () => {
    for (const step of allSteps) {
      if (!step.shortcut) continue;
      expect(
        shortcutActionIds.has(step.shortcut),
        `El paso "${step.id}" cita el atajo "${step.shortcut}", que no está ` +
          `en SHORTCUT_ACTIONS.`,
      ).toBe(true);
    }
  });

  it("las dos plataformas ven un recorrido completo", () => {
    // Un paso mal etiquetado (`platforms: ["desktop"]` en algo que también
    // existe en el móvil) deja media guía sin que nada falle en escritorio.
    for (const tour of allTours) {
      for (const platform of ["desktop", "mobile"] as TourPlatform[]) {
        const steps = visibleSteps(tour, platform);
        expect(
          steps.length,
          `${tour.id} se queda sin pasos en ${platform}`,
        ).toBeGreaterThan(0);
        expect(
          steps.map((step) => step.id),
          `${tour.id} en ${platform} debe abrir con la bienvenida y cerrar ` +
            `con el paso final`,
        ).toEqual(
          expect.arrayContaining([tour.steps[0].id, tour.steps.at(-1)!.id]),
        );
      }
    }
  });

  it("los ids de paso no se repiten dentro de un recorrido", () => {
    for (const tour of allTours) {
      const ids = tour.steps.map((step) => step.id);
      expect(new Set(ids).size, `${tour.id} tiene ids repetidos`).toBe(
        ids.length,
      );
    }
  });
});
