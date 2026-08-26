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
 * inicio describiría cosas que el usuario no tiene delante.
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

/**
 * Cómo terminó un recorrido. La diferencia importa: quien LLEGÓ AL FINAL está
 * aprendiendo y agradece que la guía siga sola al abrir la sesión; quien pulsó
 * "Saltar guía" ya ha dicho que no, y volver a saltarle encima es insistir.
 */
export type TourOutcome = "completed" | "dismissed";

export type TourProgress = Partial<Record<TourId, TourOutcome>>;

const ALL_PLATFORMS: readonly TourPlatform[] = ["desktop", "mobile"];

/**
 * Condición que completa un paso interactivo: la guía espera a que el usuario
 * abra (o cierre) algo de verdad en vez de limitarse a describirlo.
 *
 * Se expresa contra el DOM —la aparición o desaparición de un anclaje— y no
 * contra el estado de React a propósito: el panel de biblioteca y el modal de
 * ajustes se abren desde `useState` dentro de `TransportPanelContent`, y
 * sacarlos de ahí para que la guía los lea sería mover estado del hot path por
 * una feature secundaria. Mirar el DOM reutiliza el contrato de anclajes que ya
 * existe, y `tourSteps.test.ts` lo vigila igual que los demás.
 */
export type TourWaitCondition = {
  target: TourTargetId;
  /** `false` espera a que DESAPAREZCA (cerrar un panel). Por defecto `true`. */
  present?: boolean;
};

export type TourStep = {
  id: string;
  /**
   * Elemento a iluminar. Si se omite —o no está en el DOM— el paso se dibuja
   * como tarjeta centrada sin foco.
   */
  target?: TourTargetId;
  /**
   * Convierte el paso en interactivo: el usuario tiene que hacer algo y la guía
   * avanza sola al conseguirlo. Mientras espera, el escudo abre un hueco sobre
   * el control iluminado para que se pueda pulsar de verdad.
   */
  waitFor?: TourWaitCondition;
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

/** Si la condición de un paso interactivo se cumple ahora mismo. */
export function isWaitSatisfied(
  waitFor: TourWaitCondition,
  isPresent: (target: TourTargetId) => boolean,
): boolean {
  return isPresent(waitFor.target) === (waitFor.present ?? true);
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
  progress: TourProgress;
  isWebDriver: boolean;
  isTestRun: boolean;
}): boolean {
  if (options.isWebDriver || options.isTestRun) return false;
  return options.progress.landing === undefined;
}

/**
 * Si la guía del área de trabajo debe continuar sola al abrir una sesión.
 *
 * Es la continuación natural: quien acaba de terminar la guía de inicio se
 * encuentra la sesión abierta y el recorrido sigue sin tener que buscar el
 * botón. Sólo pasa si TERMINÓ la de inicio —no si la saltó— y sólo una vez.
 */
export function shouldAutoContinueWorkspaceTour(options: {
  progress: TourProgress;
  isTourActive: boolean;
  isWebDriver: boolean;
  isTestRun: boolean;
}): boolean {
  if (options.isWebDriver || options.isTestRun) return false;
  // No interrumpimos un recorrido en marcha.
  if (options.isTourActive) return false;
  if (options.progress.landing !== "completed") return false;
  return options.progress.workspace === undefined;
}
