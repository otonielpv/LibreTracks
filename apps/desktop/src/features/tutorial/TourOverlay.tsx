import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useShortcutHint } from "../transport/keyboard/shortcutHint";
import { useTimelineUIStore, type ViewMode } from "../transport/uiStore";
import { placeTourCard, type CardPosition } from "./tourCardPlacement";
import {
  autoStartTourOnLanding,
  isAnnouncementTour,
  isWaitSatisfied,
  stepBodyKeys,
} from "./tourModel";
import {
  currentTourPlatform,
  subscribeSessionTourOffer,
  useTourStore,
} from "./tourStore";
import { TOURS } from "./tours";
import {
  findTourTarget,
  TOUR_TARGETS,
  type TourTargetId,
} from "./tourTargets";

/**
 * La guía interactiva: un foco sobre el control real y una tarjeta que lo
 * explica.
 *
 * Se monta en `App.tsx`, fuera del panel de transporte, y va a `document.body`
 * por portal — el mismo patrón que `PopoverShell`. No es un capricho: el zoom
 * de interfaz aplica `zoom` sobre `.lt-app-shell`, así que un `position: fixed`
 * DENTRO del shell volvería a escalar unas coordenadas que
 * `getBoundingClientRect()` ya devuelve escaladas.
 */

/** Aire alrededor del elemento iluminado, en píxeles. */
const SPOTLIGHT_PADDING = 6;
/** Medidas de reserva para el primer cálculo, antes de que la tarjeta exista. */
const FALLBACK_CARD_WIDTH = 360;
const FALLBACK_CARD_HEIGHT = 240;

type TargetRect = {
  top: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
};

type ViewportSize = { width: number; height: number };

type SafeViewport = ViewportSize & { top: number; left: number };

function cssPixelVariable(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

/** Viewport realmente utilizable, descontando notch y barras del sistema. */
function safeTourViewport(): SafeViewport {
  const top = cssPixelVariable("--lt-safe-area-top");
  const right = cssPixelVariable("--lt-safe-area-right");
  const bottom = cssPixelVariable("--lt-safe-area-bottom");
  const left = cssPixelVariable("--lt-safe-area-left");
  return {
    top,
    left,
    width: Math.max(0, window.innerWidth - left - right),
    height: Math.max(0, window.innerHeight - top - bottom),
  };
}

function sameRect(a: TargetRect | null, b: TargetRect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

const isTargetPresent = (target: TourTargetId): boolean =>
  findTourTarget(target) !== null;

const isWebDriverSession = (): boolean =>
  typeof navigator !== "undefined" && navigator.webdriver === true;

export function TourOverlay() {
  const { t } = useTranslation();
  const activeTourId = useTourStore((state) => state.activeTourId);
  const stepIndex = useTourStore((state) => state.stepIndex);
  const steps = useTourStore((state) => state.steps);
  const endTour = useTourStore((state) => state.endTour);
  const nextStep = useTourStore((state) => state.nextStep);
  const previousStep = useTourStore((state) => state.previousStep);
  const shortcutHint = useShortcutHint();

  const platform = currentTourPlatform();
  const step = steps[stepIndex] ?? null;
  const targetId = step?.target ?? null;
  const stepViewMode = step?.viewMode ?? null;
  const waitFor = step?.waitFor ?? null;

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [cardPosition, setCardPosition] = useState<CardPosition | null>(null);
  const [spotlightSettled, setSpotlightSettled] = useState(false);
  const [waitSatisfied, setWaitSatisfied] = useState(false);
  const [viewportSize, setViewportSize] = useState<ViewportSize>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const restoreViewModeRef = useRef<ViewMode | null>(null);

  // Arranque automático al abrir la app: el primer recorrido que este usuario
  // no ha visto. Al arrancar nunca hay sesión abierta, así que siempre es uno
  // de los de la pantalla de inicio.
  //
  // No es siempre el de primeros pasos: quien lleva meses con la app y se
  // encuentra una función nueva tiene un recorrido sin ver, y no va a abrir la
  // guía por su cuenta a ver si hay novedades.
  useEffect(() => {
    const store = useTourStore.getState();
    const tourId = autoStartTourOnLanding({
      progress: store.progress,
      isWebDriver: isWebDriverSession(),
      isTestRun: import.meta.env.MODE === "test",
    });
    if (tourId) {
      store.startTour(tourId);
    }
  }, []);

  // Al cargar una sesión se despliega el menú con los recorridos que quedan,
  // para no tener que acordarse del botón. La lógica vive en el store para que
  // se pueda probar sin montar la app.
  useEffect(
    () =>
      subscribeSessionTourOffer({
        isWebDriver: isWebDriverSession(),
        isTestRun: import.meta.env.MODE === "test",
      }),
    [],
  );

  // Vista que pide el paso. Al terminar devolvemos al usuario a la vista en la
  // que estaba: la guía es una visita, no una reorganización de su sesión.
  useEffect(() => {
    if (!activeTourId) return;
    restoreViewModeRef.current = useTimelineUIStore.getState().viewMode;
    return () => {
      const restore = restoreViewModeRef.current;
      restoreViewModeRef.current = null;
      if (restore) {
        useTimelineUIStore.getState().setViewMode(restore);
      }
    };
  }, [activeTourId]);

  useEffect(() => {
    if (!activeTourId || !stepViewMode) return;
    if (useTimelineUIStore.getState().viewMode !== stepViewMode) {
      useTimelineUIStore.getState().setViewMode(stepViewMode);
    }
  }, [activeTourId, stepViewMode, stepIndex]);

  // Medida del elemento iluminado.
  const measure = useCallback(() => {
    setViewportSize((current) => {
      const next = { width: window.innerWidth, height: window.innerHeight };
      return current.width === next.width && current.height === next.height
        ? current
        : next;
    });
    const element = targetId ? findTourTarget(targetId) : null;
    if (!element) {
      setTargetRect((current) => (current === null ? current : null));
      return;
    }
    const rect = element.getBoundingClientRect();
    const next: TargetRect = {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
    setTargetRect((current) => (sameRect(current, next) ? current : next));
  }, [targetId]);

  const revealAndMeasure = useCallback(() => {
    const element = targetId ? findTourTarget(targetId) : null;
    // Varias herramientas (Master, tono y Warp en móvil) viven en una barra
    // horizontal desplazable. Mostrar un paso sin traer antes su control al
    // tramo visible dejaba la pantalla oscura pero sin ningún marco útil.
    element?.scrollIntoView?.({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
    measure();
  }, [measure, targetId]);

  useLayoutEffect(() => {
    if (!activeTourId) return;
    revealAndMeasure();
    // Un paso puede cambiar de vista (el del timeline pide la DAW) y el
    // elemento no existe hasta el frame siguiente. Una sola remedida basta:
    // esto no es un bucle de sondeo.
    const frame = requestAnimationFrame(revealAndMeasure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [activeTourId, measure, revealAndMeasure, stepIndex]);

  // La biblioteca es necesaria durante sus tres explicaciones, pero en móvil
  // ocupa el lienzo entero y en escritorio estrecha el timeline. La cerramos
  // al terminar ese bloque; si el usuario vuelve atrás, la abrimos otra vez.
  useEffect(() => {
    if (activeTourId !== "workspace" || !step) return;
    const libraryIsOpen = Boolean(findTourTarget(TOUR_TARGETS.libraryPanel));
    const isLibraryDetail = [
      "libraryContents",
      "libraryImport",
      "libraryFolders",
    ].includes(step.id);
    const shouldToggle =
      (step.id === "timeline" && libraryIsOpen) ||
      (isLibraryDetail && !libraryIsOpen);
    if (!shouldToggle) return;

    findTourTarget(TOUR_TARGETS.sideNavLibrary)?.click();
    // El panel se desmonta y el timeline recupera ancho en el siguiente render.
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [activeTourId, measure, step]);

  // El foco se anima al MOVERSE de un control a otro, pero no al aparecer: sin
  // esto entra volando desde la esquina (0,0) hasta su sitio, porque la
  // transición también corre en el primer pintado. Un frame después del primer
  // posicionamiento habilitamos la animación.
  useEffect(() => {
    if (!targetRect) {
      setSpotlightSettled(false);
      return;
    }
    if (spotlightSettled) return;
    const frame = requestAnimationFrame(() => setSpotlightSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [targetRect, spotlightSettled]);

  // Pasos interactivos: esperamos a que el usuario abra (o cierre) algo de
  // verdad y avanzamos solos. Si la condición YA se cumple al entrar en el paso
  // no auto-avanzamos, o volver atrás rebotaría hacia delante al instante.
  useEffect(() => {
    if (!activeTourId || !waitFor) {
      setWaitSatisfied(false);
      return;
    }
    const initiallySatisfied = isWaitSatisfied(waitFor, isTargetPresent);
    setWaitSatisfied(initiallySatisfied);
    if (initiallySatisfied) return;

    let frame = 0;
    const check = () => {
      frame = 0;
      if (isWaitSatisfied(waitFor, isTargetPresent)) {
        setWaitSatisfied(true);
        nextStep();
      }
    };
    // Sólo `childList`: abrir el panel o el modal los monta y desmonta. Ignorar
    // los atributos mantiene el observador callado mientras el playhead se
    // mueve a 60fps mutando estilos.
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(check);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [activeTourId, waitFor, stepIndex, nextStep]);

  // La misma colocación geométrica sirve en escritorio, tablet y móvil. La
  // plataforma sólo cambia el tamaño mediante CSS: decidir "móvil = borde" sin
  // mirar el objetivo hacía que el texto tapara vistas y timelines enteros.
  useLayoutEffect(() => {
    if (!activeTourId || !targetRect) {
      setCardPosition(null);
      return;
    }
    const card = cardRef.current;
    const viewport = safeTourViewport();
    const position = placeTourCard(
      {
        top: targetRect.top - viewport.top,
        left: targetRect.left - viewport.left,
        width: targetRect.width,
        height: targetRect.height,
      },
      {
        width: card?.offsetWidth || FALLBACK_CARD_WIDTH,
        // La altura pintada, no `scrollHeight`: CSS limita el cuerpo y deja los
        // botones fijos cuando el texto necesita desplazarse.
        height: card?.offsetHeight || FALLBACK_CARD_HEIGHT,
      },
      viewport,
    );
    setCardPosition(
      position
        ? {
            top: position.top + viewport.top,
            left: position.left + viewport.left,
          }
        : null,
    );
  }, [
    activeTourId,
    targetRect,
    stepIndex,
    viewportSize.height,
    viewportSize.width,
  ]);

  // Teclado, en captura y cortando la propagación: las flechas son
  // `edit.nudge*` en el timeline, así que sin esto avanzar de paso movería los
  // clips del usuario.
  useEffect(() => {
    if (!activeTourId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        endTour("dismissed");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        nextStep();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        previousStep();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeTourId, endTour, nextStep, previousStep]);

  if (!activeTourId || !step) return null;

  const total = steps.length;
  const isLastStep = stepIndex === total - 1;
  const [primaryBodyKey, fallbackBodyKey] = stepBodyKeys(step, platform);
  const body = fallbackBodyKey
    ? t(primaryBodyKey, { defaultValue: t(fallbackBodyKey) })
    : t(primaryBodyKey);
  const hint = step.shortcut ? shortcutHint(step.shortcut) : "";
  // Está esperando a que el usuario actúe: el escudo abre un hueco sobre el
  // control y el botón principal pasa a ser una salida, no el camino normal.
  const isAwaitingUser = waitFor !== null && !waitSatisfied;

  const holeRect =
    isAwaitingUser && targetRect
      ? {
          top: Math.max(0, targetRect.top - SPOTLIGHT_PADDING),
          left: Math.max(0, targetRect.left - SPOTLIGHT_PADDING),
          bottom: targetRect.bottom + SPOTLIGHT_PADDING,
          right: targetRect.left + targetRect.width + SPOTLIGHT_PADDING,
        }
      : null;

  // Si ni la tarjeta limitada por CSS cabe en el viewport, `placeTourCard`
  // devuelve null y se centra. Cuando no cabe junto al objetivo, el algoritmo
  // conserva visible la mayor porción posible en vez de centrarla encima.
  const cardStyle: CSSProperties =
    cardPosition
      ? { top: `${cardPosition.top}px`, left: `${cardPosition.left}px` }
      : {};

  const cardClassName = [
    "lt-tour-card",
    !cardPosition ? "is-centred" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div
      className="lt-tour-root"
      /* Qué recorrido y qué paso hay en pantalla, en claro. Lo leen los E2E
         —que corren con la app en español y no deberían depender del idioma—
         y sirve para depurar sin abrir React DevTools. */
      data-tour-id={activeTourId}
      data-tour-step={step.id}
      data-tour-awaiting={isAwaitingUser ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lt-tour-title"
    >
      {/* El escudo traga los clics para que un toque perdido durante la guía no
          edite el proyecto. En los pasos interactivos se parte en cuatro bandas
          alrededor del control, que así se puede pulsar de verdad. */}
      {holeRect ? (
        <>
          <div
            className="lt-tour-shield"
            style={{ top: 0, left: 0, right: 0, height: `${holeRect.top}px` }}
          />
          <div
            className="lt-tour-shield"
            style={{ top: `${holeRect.bottom}px`, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="lt-tour-shield"
            style={{
              top: `${holeRect.top}px`,
              left: 0,
              width: `${holeRect.left}px`,
              height: `${holeRect.bottom - holeRect.top}px`,
            }}
          />
          <div
            className="lt-tour-shield"
            style={{
              top: `${holeRect.top}px`,
              left: `${holeRect.right}px`,
              right: 0,
              height: `${holeRect.bottom - holeRect.top}px`,
            }}
          />
        </>
      ) : (
        <div
          className="lt-tour-shield is-full"
          onPointerDown={(event) => event.preventDefault()}
        />
      )}
      {targetRect ? (
        <div
          className={`lt-tour-spotlight${spotlightSettled ? " is-settled" : ""}${
            isAwaitingUser ? " is-awaiting" : ""
          }`}
          aria-hidden="true"
          style={{
            top: `${targetRect.top - SPOTLIGHT_PADDING}px`,
            left: `${targetRect.left - SPOTLIGHT_PADDING}px`,
            width: `${targetRect.width + SPOTLIGHT_PADDING * 2}px`,
            height: `${targetRect.height + SPOTLIGHT_PADDING * 2}px`,
          }}
        />
      ) : (
        <div className="lt-tour-dim" aria-hidden="true" />
      )}
      <div ref={cardRef} className={cardClassName} style={cardStyle}>
        <span className="lt-tour-eyebrow">
          {isAnnouncementTour(activeTourId) ? (
            <span className="lt-tour-new-badge">
              {t("tutorial.newBadge", { defaultValue: "Novedad" })}
            </span>
          ) : null}
          {t("tutorial.progress", {
            tour: t(`${TOURS[activeTourId].i18nKey}.name`),
            current: stepIndex + 1,
            total,
          })}
        </span>
        <h2 id="lt-tour-title">{t(`${step.i18nKey}.title`)}</h2>
        <p className="lt-tour-body">{body}</p>
        {hint ? (
          <p className="lt-tour-shortcut">
            {t("tutorial.shortcutHint", { binding: hint })}
          </p>
        ) : null}
        {isAwaitingUser ? (
          <p className="lt-tour-waiting" role="status">
            <span className="material-symbols-outlined" aria-hidden="true">
              touch_app
            </span>
            {t("tutorial.waiting")}
          </p>
        ) : null}
        <div className="lt-tour-dots" aria-hidden="true">
          {steps.map((dotStep, index) => (
            <span
              key={dotStep.id}
              className={
                index === stepIndex
                  ? "is-current"
                  : index < stepIndex
                    ? "is-done"
                    : ""
              }
            />
          ))}
        </div>
        <div className="lt-tour-actions">
          <button
            type="button"
            className="lt-tour-skip"
            onClick={() => endTour("dismissed")}
          >
            {t("tutorial.skip")}
          </button>
          <div className="lt-tour-actions-main">
            {stepIndex > 0 ? (
              <button type="button" onClick={previousStep}>
                {t("tutorial.back")}
              </button>
            ) : null}
            {/* Se enfoca solo al abrir la guía, no en cada paso: el botón
                ocupa siempre la misma posición del árbol, así que React lo
                reutiliza y `autoFocus` sólo dispara en el montaje. */}
            <button
              type="button"
              className={isAwaitingUser ? "" : "is-primary"}
              autoFocus
              onClick={nextStep}
            >
              {isAwaitingUser
                ? t("tutorial.skipStep")
                : isLastStep
                  ? t("tutorial.finish")
                  : t("tutorial.next")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
