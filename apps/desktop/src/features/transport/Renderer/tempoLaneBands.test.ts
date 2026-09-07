import { describe, expect, it } from "vitest";
import {
  LANE_TEMPO_METRIC,
  TEMPO_FLAG_BAND,
  TIME_SIGNATURE_FLAG_BAND,
} from "./drawBackground";

/**
 * El carril de tempo/compás lo comparten dos marcas distintas.
 *
 * Sus zonas táctiles cubrían el carril ENTERO cada una, así que con un tempo y
 * un compás en el mismo punto la de compás —que se pinta después— se comía
 * todos los clics: no había forma de editar el BPM sin borrar antes el compás.
 * Pasaba igual en escritorio.
 */
describe("las dos bandas del carril de tempo y compás", () => {
  it("no se solapan: cada punto del carril es de UNA marca", () => {
    const tempoBottom = TEMPO_FLAG_BAND.top + TEMPO_FLAG_BAND.height;
    expect(tempoBottom).toBeLessThanOrEqual(TIME_SIGNATURE_FLAG_BAND.top);
  });

  it("son contiguas: entre las dos no dejan huecos muertos", () => {
    expect(TEMPO_FLAG_BAND.top).toBe(LANE_TEMPO_METRIC.top);
    expect(TEMPO_FLAG_BAND.top + TEMPO_FLAG_BAND.height).toBe(
      TIME_SIGNATURE_FLAG_BAND.top,
    );
  });

  it("cada banda cubre su propia bandera", () => {
    // La de compas se dibuja un poco por debajo del carril; su zona tiene que
    // llegar hasta donde llega ella, o el trozo visible no responde.
    expect(
      TIME_SIGNATURE_FLAG_BAND.top + TIME_SIGNATURE_FLAG_BAND.height,
    ).toBeGreaterThanOrEqual(LANE_TEMPO_METRIC.top + LANE_TEMPO_METRIC.height);
  });

  it("las dos dan sitio a un dedo", () => {
    // Por debajo de esto el destino deja de ser alcanzable en un móvil.
    expect(TEMPO_FLAG_BAND.height).toBeGreaterThanOrEqual(12);
    expect(TIME_SIGNATURE_FLAG_BAND.height).toBeGreaterThanOrEqual(12);
  });
});
