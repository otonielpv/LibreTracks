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

import {
  calculatePopoverAnchor,
  type PopoverAnchor,
} from "../transport/panels/popoverPosition";
import { useShortcutHint } from "../transport/keyboard/shortcutHint";
import { useTimelineUIStore, type ViewMode } from "../transport/uiStore";
import { shouldAutoStartLandingTour, stepBodyKeys } from "./tourModel";
import { currentTourPlatform, useTourStore } from "./tourStore";
import { TOURS } from "./tours";
import { findTourTarget } from "./tourTargets";

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

function sameRect(a: TargetRect | null, b: TargetRect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

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

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const restoreViewModeRef = useRef<ViewMode | null>(null);

  // Arranque automático la primera vez que se abre la app. Siempre el
  // recorrido de la pantalla de inicio: al arrancar nunca hay sesión abierta.
  useEffect(() => {
    const store = useTourStore.getState();
    if (
      !shouldAutoStartLandingTour({
        seenTours: store.seenTours,
        isWebDriver:
          typeof navigator !== "undefined" && navigator.webdriver === true,
        isTestRun: import.meta.env.MODE === "test",
      })
    ) {
      return;
    }
    store.startTour("landing");
  }, []);

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

  useLayoutEffect(() => {
    if (!activeTourId) return;
    measure();
    // Un paso puede cambiar de vista (el del timeline pide la DAW) y el
    // elemento no existe hasta el frame siguiente. Una sola remedida basta:
    // esto no es un bucle de sondeo.
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [activeTourId, measure, stepIndex]);

  // Colocación de la tarjeta en escritorio. En móvil se ancla a un borde y no
  // hace falta calcular nada.
  useLayoutEffect(() => {
    if (!activeTourId || platform === "mobile" || !targetRect) {
      setAnchor(null);
      return;
    }
    const card = cardRef.current;
    setAnchor(
      calculatePopoverAnchor(
        targetRect,
        card?.offsetWidth || FALLBACK_CARD_WIDTH,
        card?.scrollHeight || FALLBACK_CARD_HEIGHT,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [activeTourId, platform, targetRect, stepIndex]);

  // Teclado, en captura y cortando la propagación: las flechas son
  // `edit.nudge*` en el timeline, así que sin esto avanzar de paso movería los
  // clips del usuario.
  useEffect(() => {
    if (!activeTourId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        endTour();
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

  // En móvil la tarjeta ocupa el borde inferior salvo que el foco esté en la
  // mitad baja de la pantalla, donde lo taparía.
  const isDocked = platform === "mobile";
  const dockTop =
    isDocked &&
    targetRect !== null &&
    targetRect.bottom > window.innerHeight * 0.55;

  const cardStyle: CSSProperties =
    !isDocked && anchor
      ? { top: `${anchor.top}px`, left: `${anchor.left}px` }
      : {};

  const cardClassName = [
    "lt-tour-card",
    isDocked ? (dockTop ? "is-docked-top" : "is-docked-bottom") : null,
    !isDocked && !anchor ? "is-centred" : null,
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
      role="dialog"
      aria-modal="true"
      aria-labelledby="lt-tour-title"
    >
      {/* Traga los clics: un toque perdido durante la guía no debe editar el
          proyecto del usuario. */}
      <div
        className="lt-tour-shield"
        onPointerDown={(event) => event.preventDefault()}
      />
      {targetRect ? (
        <div
          className="lt-tour-spotlight"
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
          <button type="button" className="lt-tour-skip" onClick={endTour}>
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
              className="is-primary"
              autoFocus
              onClick={nextStep}
            >
              {isLastStep ? t("tutorial.finish") : t("tutorial.next")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
