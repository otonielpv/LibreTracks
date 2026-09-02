import type { ShortcutActionId } from "../transport/keyboard/actions";
import type { ViewMode } from "../transport/uiStore";
import type { TourTargetId } from "./tourTargets";

/**
 * Modelo de la guía interactiva.
 *
 * Los recorridos están partidos por pantalla y por tema, no encadenados en uno:
 *
 * - `landing` — sin sesión abierta. Aquí no existen ni la línea de tiempo ni
 *   las tres vistas ni el mezclador; lo único que hay que aprender es qué es
 *   una sesión y cómo crearla, abrirla o importarla.
 * - `workspace` — con la sesión abierta: dónde está cada zona.
 * - `daw` — montar una canción: regla, regiones, marcas, pistas y clips.
 * - `live` — preparar el directo: saltos, vamp, master, tono y warp.
 *
 * Un único recorrido que hablara de la línea de tiempo desde la pantalla de
 * inicio describiría cosas que el usuario no tiene delante; y uno que juntara
 * los tres del área de trabajo pasaría de treinta pasos, que nadie repasa para
 * consultar una cosa.
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

export type TourId = "landing" | "workspace" | "daw" | "live" | "cloud";

/**
 * En qué pantalla está el usuario. Lo mismo que decide `toursForContext`.
 *
 * Existe porque el recorrido de la nube es el único que se ofrece en LAS DOS
 * pantallas: sus puntos de entrada viven en el inicio (el botón Nube) y dentro
 * de la sesión (exportar e importar). Sus pasos se filtran por contexto igual
 * que los demás se filtran por plataforma, en vez de partirlo en dos recorridos
 * que contarían lo mismo.
 */
export type TourContext = "landing" | "session";

/**
 * Cómo terminó un recorrido. La diferencia importa: quien LLEGÓ AL FINAL está
 * aprendiendo y agradece que la guía siga sola al abrir la sesión; quien pulsó
 * "Saltar guía" ya ha dicho que no, y volver a saltarle encima es insistir.
 */
export type TourOutcome = "completed" | "dismissed";

export type TourProgress = Partial<Record<TourId, TourOutcome>>;

const ALL_PLATFORMS: readonly TourPlatform[] = ["desktop", "mobile"];
const ALL_CONTEXTS: readonly TourContext[] = ["landing", "session"];

/**
 * Recorridos que anuncian una funcion NUEVA, no los primeros pasos.
 *
 * Cambian en dos cosas: la tarjeta los etiqueta como novedad, y se anuncian
 * aunque el usuario haya saltado un recorrido alguna vez. Un "Saltar" significa
 * "no me expliques la app", no "no me cuentes nunca lo que cambia" -- y a quien
 * lleva meses usandola no se le puede pedir que abra la guia por su cuenta a
 * ver si hay novedades.
 *
 * Vive aqui y no en la definicion del recorrido porque `tourModel` no puede
 * importar el catalogo sin cerrar un ciclo, y tener la marca en dos sitios es
 * peor que tenerla en el que ambos pueden leer.
 */
const ANNOUNCEMENT_TOURS: readonly TourId[] = ["cloud"];

/** Si este recorrido se presenta como novedad. */
export function isAnnouncementTour(tourId: TourId): boolean {
  return ANNOUNCEMENT_TOURS.includes(tourId);
}

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
  /**
   * Pantallas donde aplica el paso. Omitido = las dos.
   *
   * Solo lo usa el recorrido de la nube, que se ofrece con sesión y sin ella y
   * tiene que iluminar cosas distintas en cada caso: el botón Nube del inicio
   * no existe dentro de la sesión, y el menú de archivo no existe fuera.
   */
  contexts?: readonly TourContext[];
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
 * Los recorridos que se ofrecen en cada pantalla, en el orden del menú.
 *
 * Con sesión abierta son tres, y ese reparto es intencionado: el primero enseña
 * DÓNDE está cada zona, y los otros dos enseñan a TRABAJAR dentro de ellas.
 * Encadenarlos en uno solo pasaría de treinta pasos, y nadie repasa el warp
 * tragándose antes veinte pantallas sobre la biblioteca.
 *
 * Puras y aparte del store para poder probar la decisión sin montar la app.
 */
export function toursForContext(hasOpenSession: boolean): TourId[] {
  // `cloud` sale en las dos: es lo único que se usa igual con sesión abierta y
  // sin ella, y para quien ya terminó el tutorial es además la novedad que hay
  // que contarle.
  return hasOpenSession
    ? ["workspace", "daw", "live", "cloud"]
    : ["landing", "cloud"];
}

/** El contexto que corresponde a lo que hay en pantalla. */
export function contextFor(hasOpenSession: boolean): TourContext {
  return hasOpenSession ? "session" : "landing";
}

/**
 * El primer recorrido de esta pantalla que el usuario no ha visto todavia.
 *
 * Es lo que encadena la pantalla de inicio: quien empieza de cero hace
 * "Primeros pasos" y sigue con el de la nube; quien ya termino el tutorial en su
 * dia solo tiene pendiente el de la nube y va directo a el. Nadie elige de un
 * menu antes de haber visto nada, y el orden es el natural — primero que es una
 * sesion, luego como moverla.
 *
 * `null` cuando ya se han visto todos.
 */
export function nextUnseenTour(
  hasOpenSession: boolean,
  progress: TourProgress,
): TourId | null {
  return (
    toursForContext(hasOpenSession).find(
      (tourId) => progress[tourId] === undefined,
    ) ?? null
  );
}

/** El recorrido por defecto de la pantalla: el primero de su lista. */
export function tourIdForContext(hasOpenSession: boolean): TourId {
  return toursForContext(hasOpenSession)[0];
}

/**
 * Los pasos que esta plataforma y esta pantalla llegan a ver, en orden.
 *
 * `context` es opcional para no obligar a los recorridos de una sola pantalla
 * —todos menos el de la nube— a decir dónde están.
 */
export function visibleSteps(
  tour: TourDefinition,
  platform: TourPlatform,
  context?: TourContext,
): TourStep[] {
  return tour.steps.filter(
    (step) =>
      (step.platforms ?? ALL_PLATFORMS).includes(platform) &&
      (context === undefined ||
        (step.contexts ?? ALL_CONTEXTS).includes(context)),
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
  return autoStartTourOnLanding(options) !== null;
}

/**
 * Que recorrido arranca solo al abrir la app, o `null` si ninguno.
 *
 * Ya no es siempre el de primeros pasos. Cuando se anade una funcion con
 * recorrido propio, quien lleva meses usando la app tiene un recorrido sin ver
 * y merece enterarse sin tener que pulsar TUTORIAL: alguien que ya se sabe el
 * programa no va a abrir la guia por su cuenta a ver si hay novedades.
 *
 * La condicion de siempre se mantiene y es la que protege de la insistencia: un
 * "Saltar" en cualquier recorrido es un no explicito y vale para todos. Quien
 * cerro el tutorial el primer dia no quiere que le salte otro seis meses
 * despues.
 */
export function autoStartTourOnLanding(options: {
  progress: TourProgress;
  isWebDriver: boolean;
  isTestRun: boolean;
}): TourId | null {
  if (options.isWebDriver || options.isTestRun) return null;
  const next = nextUnseenTour(false, options.progress);
  if (next === null) return null;
  // Una novedad se anuncia aunque en su dia se saltara el tutorial; los
  // primeros pasos no vuelven a insistir a quien ya dijo que no.
  if (isAnnouncementTour(next)) return next;
  return Object.values(options.progress).includes("dismissed") ? null : next;
}

/**
 * Si al abrir una sesión hay que ofrecer los recorridos del área de trabajo.
 *
 * Abre el MENÚ, no un recorrido: con la sesión abierta hay tres y elegir es del
 * usuario. Lanzar dieciséis pasos sin preguntar es una emboscada; enseñar la
 * lista es una invitación.
 *
 * Dos condiciones, y la segunda es la que de verdad importa:
 *
 * 1. Queda algo por ver. Quien ya hizo el general pero no ha tocado montaje ni
 *    directo sigue teniendo algo que descubrir.
 * 2. NADIE ha dicho que no todavía. Un "Saltar tutorial" —el de la pantalla de
 *    inicio incluido— es un no explícito, y vale para todos: quien cierra el
 *    primero no quiere que le abramos un menú cada vez que carga una sesión.
 *    Sin esta regla pasaba justo eso, porque saltar el de inicio dejaba los
 *    otros tres "sin ver" y el menú reaparecía una y otra vez.
 *
 * Y dos frenos más: nunca encima de un recorrido en marcha, y una sola vez por
 * arranque de la app (`alreadyOffered`).
 *
 * "Empezar de cero" borra el progreso entero, así que también devuelve la
 * oferta a quien la apagó y se arrepintió.
 */
export function shouldOfferToursOnSessionOpen(options: {
  progress: TourProgress;
  isTourActive: boolean;
  alreadyOffered: boolean;
  isWebDriver: boolean;
  isTestRun: boolean;
}): boolean {
  if (options.isWebDriver || options.isTestRun) return false;
  if (options.isTourActive || options.alreadyOffered) return false;
  if (Object.values(options.progress).includes("dismissed")) return false;
  return toursForContext(true).some(
    (tourId) => options.progress[tourId] === undefined,
  );
}
