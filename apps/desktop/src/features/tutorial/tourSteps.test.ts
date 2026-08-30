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

  it("ningún anclaje se cuela como texto en vez de como atributo", () => {
    // Pasó de verdad: al insertar el anclaje detrás de `<label className="...">`
    // —una etiqueta que ya cerraba con `>`— cayó DENTRO del elemento, y la
    // barra superior mostraba «data-lt-tour=topbar-tempo» escrito en pantalla.
    //
    // El escaneo de anclajes de arriba no lo veía: busca el texto en el fuente
    // y lo encuentra igual sea atributo o contenido. Esto mira qué hay justo
    // antes; si es `>`, el anclaje está fuera de la etiqueta.
    for (const file of collectComponentFiles(srcRoot)) {
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(ANCHOR_PATTERN)) {
        const before = contents.slice(0, match.index).trimEnd();
        expect(
          before.endsWith(">"),
          `${file}: "${match[0]}" está fuera de su etiqueta y se pintará como ` +
            `texto en la interfaz. Métela dentro del tag.`,
        ).toBe(false);
      }
    }
  });

  it("todo anclaje acaba en un elemento del DOM, no en props de un componente", () => {
    // Pasó de verdad, y es el fallo más silencioso de todos: los grupos de la
    // barra del timeline son `<ControlGroup>`, no `<div>`. El `data-lt-tour`
    // se quedaba en las props del componente y no llegaba nunca al DOM, así
    // que el recorrido de directo no resaltaba ni uno de sus seis controles —
    // y todos los tests pasaban, porque el anclaje SÍ estaba en el fuente.
    //
    // Un componente puede llevar anclaje, pero tiene que reenviarlo a su raíz.
    // Los que lo hacen van aquí, y cada uno tiene su test de que lo reenvía.
    const FORWARDING_COMPONENTS = new Set(["ControlGroup"]);
    const openingTag = /<([A-Za-z][\w.]*)/g;

    for (const file of collectComponentFiles(srcRoot)) {
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(ANCHOR_PATTERN)) {
        const before = contents.slice(0, match.index);
        const tags = [...before.matchAll(openingTag)];
        const owner = tags.at(-1)?.[1] ?? "?";
        const reachesDom =
          owner[0] === owner[0].toLowerCase() ||
          FORWARDING_COMPONENTS.has(owner);
        expect(
          reachesDom,
          `${file}: "${match[0]}" cuelga de <${owner}>, que es un componente. ` +
            `El atributo se queda en sus props y no llega al DOM: o lo pones ` +
            `en un elemento real, o haces que <${owner}> lo reenvíe y lo ` +
            `añades a FORWARDING_COMPONENTS con su test.`,
        ).toBe(true);
      }
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

  it("los textos no llaman «guía» al tutorial", () => {
    // La feature se llamó «Guía» y chocaba con la VOZ GUÍA, que es otra cosa
    // del producto y sale en los mismos párrafos ("la mezcla, el clic y la voz
    // guía"). Igual en inglés con "voice guide". Este test impide que la
    // palabra se cuele otra vez al escribir un paso nuevo.
    for (const [language, bundle, word, allowed] of [
      ["es", es, /gu[ií]a/i, "voz guía"],
      ["en", en, /guide/i, "voice guide"],
    ] as const) {
      const strings: string[] = [];
      const walk = (node: unknown): void => {
        if (typeof node === "string") {
          strings.push(node);
        } else if (typeof node === "object" && node !== null) {
          Object.values(node).forEach(walk);
        }
      };
      walk((bundle as Record<string, unknown>).tutorial);

      for (const value of strings) {
        const withoutFeature = value.split(allowed).join("");
        expect(
          word.test(withoutFeature),
          `${language}: «${value}» llama "guía" al tutorial. Ese nombre es de ` +
            `la voz guía; usa "tutorial".`,
        ).toBe(false);
      }
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

  // La guía no puede enseñar lo que la plataforma no tiene: `midir` no tiene
  // backend móvil, así que en el teléfono no hay pestañas MIDI en ajustes y el
  // paso hablaba de un puerto y un canal que el usuario no podía configurar.
  it("no enseña MIDI en móvil, donde no hay a dónde enviarlo", () => {
    const mobileIds = visibleSteps(TOURS.daw, "mobile").map((step) => step.id);
    const desktopIds = visibleSteps(TOURS.daw, "desktop").map((step) => step.id);

    expect(mobileIds).not.toContain("midiTracks");
    expect(desktopIds).toContain("midiTracks");
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
