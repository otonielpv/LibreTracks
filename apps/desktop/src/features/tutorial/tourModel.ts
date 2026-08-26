import type { ShortcutActionId } from "../transport/keyboard/actions";
import type { ViewMode } from "../transport/uiStore";
import type { TourTargetId } from "./tourTargets";

/**
 * Modelo de la guía interactiva.
 *
 * Hay DOS recorridos, no uno, porque hay dos pantallas con vocabularios
 * distintos:
 *
 * - `landing` — sin sesión abierta. Aquí no existen ni la línea de tiempo ni
 *   las tres vistas ni el mezclador; lo único que hay que aprender es qué es
 *   una sesión y cómo crearla, abrirla o importarla.
 * - `workspace` — con la sesión abierta. Aquí sí viven las pistas, los clips,
 *   el transporte y las vistas.
 *
 * Un único recorrido que hablara de la línea de tiempo desde la pantalla de
 * inicio describiría cosas que el usuario no tiene delante — que es justo lo
 * que hacía la primera versión.
 *
 * Los pasos son DATOS, no JSX. Escritorio y móvil comparten recorrido y solo se
 * separan donde de verdad se diferencian:
 *
 * - `platforms` — el paso solo existe en una plataforma (Remote no existe en
 *   móvil; el menú ARCHIVO no se dibuja allí, sus entradas viven en el rail).
 * - `bodyMobile` — mismo botón, distinta instrucción ("arrastra" vs "mantén
 *   pulsado"). Lo resuelve i18next con una clave de reserva, sin `if` en la UI.
 */

export type TourPlatform = "desktop" | "mobile";

/** Cada contexto de pantalla tiene su recorrido; los ids coinciden a propósito. */
export type TourId = "landing" | "workspace";

const ALL_PLATFORMS: readonly TourPlatform[] = ["desktop", "mobile"];

export type TourStep = {
  id: string;
  /**
   * Elemento a iluminar. Si se omite —o no está en el DOM— el paso se dibuja
   * como tarjeta centrada sin foco.
   */
  target?: TourTargetId;
  /** Plataformas donde aplica el paso. Omitido = las dos. */
  platforms?: readonly TourPlatform[];
  /** Vista a la que la guía cambia antes de mostrar el paso. */
  viewMode?: ViewMode;
  /**
   * Prefijo i18n del paso: se leen `<i18nKey>.title` y `<i18nKey>.body`, y en
   * móvil `<i18nKey>.bodyMobile` si existe.
   */
  i18nKey: string;
  /**
   * Atajo cuya combinación actual se muestra junto al texto. En móvil no se
   * pinta nada: `useShortcutHint` ya devuelve "" allí, así que un teléfono
   * nunca acaba leyendo "Ctrl+D".
   */
  shortcut?: ShortcutActionId;
};

export type TourDefinition = {
  id: TourId;
  /** Prefijo i18n del recorrido: se lee `<i18nKey>.name`. */
  i18nKey: string;
  steps: readonly TourStep[];
};

/**
 * Qué recorrido toca según lo que el usuario tiene delante.
 *
 * Pura y aparte del store para poder probar la decisión sin montar la app.
 */
export function tourIdForContext(hasOpenSession: boolean): TourId {
  return hasOpenSession ? "workspace" : "landing";
}

/** Los pasos que esta plataforma llega a ver, en orden. */
export function visibleSteps(
  tour: TourDefinition,
  platform: TourPlatform,
): TourStep[] {
  return tour.steps.filter((step) =>
    (step.platforms ?? ALL_PLATFORMS).includes(platform),
  );
}

/**
 * Claves del cuerpo del paso, de la más específica a la de reserva. La primera
 * que exista es la que se pinta.
 */
export function stepBodyKeys(step: TourStep, platform: TourPlatform): string[] {
  return platform === "mobile"
    ? [`${step.i18nKey}.bodyMobile`, `${step.i18nKey}.body`]
    : [`${step.i18nKey}.body`];
}

/**
 * Si la guía de la pantalla de inicio debe arrancar sola.
 *
 * Solo arranca sola la de `landing`, que es donde empieza todo el mundo. La de
 * `workspace` NO se lanza al abrir la primera sesión: ese es justo el momento
 * en que el usuario quiere empezar a trabajar, y un modal encima se lee como un
 * estorbo. Se ofrece desde el botón GUÍA, y el último paso de la guía de inicio
 * avisa de que está ahí.
 *
 * Función pura y aparte del efecto a propósito: es la única lógica del arranque
 * automático que merece un test, y comprobarla contra el DOM real costaría
 * montar la app entera.
 *
 * `isTestRun` es el cinturón, no los tirantes: `testUtils` ya marca los
 * recorridos como vistos en su `beforeEach`, pero un test que renderice `<App />`
 * sin pasar por ahí tendría el overlay tapando la UI y el fallo sería
 * desconcertante.
 */
export function shouldAutoStartLandingTour(options: {
  seenTours: readonly TourId[];
  isWebDriver: boolean;
  isTestRun: boolean;
}): boolean {
  if (options.isWebDriver || options.isTestRun) return false;
  return !options.seenTours.includes("landing");
}
