import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useSongStore } from "../transport/songStore";
import { toursForContext } from "./tourModel";
import { useTourStore } from "./tourStore";
import { TOURS } from "./tours";
import { TOUR_TARGETS } from "./tourTargets";

/**
 * Botón GUÍA del rail lateral, y su menú de recorridos.
 *
 * Lo que se ofrece depende de lo que hay en pantalla: en la pantalla de inicio
 * sólo hay un recorrido y el botón lo lanza directamente; con la sesión abierta
 * hay tres y se elige en un menú. Que sean varios y repetibles por separado es
 * el punto: quien sólo quiere repasar el warp no debería tragarse antes veinte
 * pantallas sobre la biblioteca.
 *
 * Habla con el store de la guía directamente en vez de recibir handlers por
 * props. Así `TransportPanelContent` no gana ni una línea de estado ni de
 * lógica por esta feature: `SideNav` monta el botón y se acabó.
 */
export function TourLauncherButton() {
  const { t } = useTranslation();
  const startTour = useTourStore((state) => state.startTour);
  const progress = useTourStore((state) => state.progress);
  const hasOpenSession = useSongStore((state) => state.song !== null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const available = toursForContext(hasOpenSession);
  const onlyTour = available.length === 1 ? available[0] : null;

  // Cerrar al pulsar fuera o con Escape, como los demás menús del rail.
  useEffect(() => {
    if (!isMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !wrapperRef.current?.contains(target)) {
        setIsMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMenuOpen]);

  return (
    <div className="lt-tour-launcher" ref={wrapperRef}>
      <button
        type="button"
        className={isMenuOpen ? "is-active" : ""}
        data-lt-tour={TOUR_TARGETS.sideNavHelp}
        aria-label={
          onlyTour
            ? t("tutorial.launchAria", {
                tour: t(`${TOURS[onlyTour].i18nKey}.name`),
              })
            : t("tutorial.chooseAria")
        }
        aria-haspopup={onlyTour ? undefined : "menu"}
        aria-expanded={onlyTour ? undefined : isMenuOpen}
        onClick={() => {
          if (onlyTour) {
            startTour(onlyTour);
            return;
          }
          setIsMenuOpen((open) => !open);
        }}
      >
        <span className="material-symbols-outlined">school</span>
        {t("tutorial.launch")}
      </button>

      {isMenuOpen && !onlyTour ? (
        <div
          className="lt-tour-menu"
          role="menu"
          aria-label={t("tutorial.chooseAria")}
        >
          <span className="lt-tour-menu-title">{t("tutorial.chooseTitle")}</span>
          {available.map((tourId) => (
            <button
              key={tourId}
              type="button"
              role="menuitem"
              data-tour-choice={tourId}
              onClick={() => {
                setIsMenuOpen(false);
                startTour(tourId);
              }}
            >
              <span className="lt-tour-menu-name">
                {t(`${TOURS[tourId].i18nKey}.name`)}
                {/* Marcar lo ya terminado convierte el menú en un índice de por
                    dónde vas, no en una lista de opciones sueltas. */}
                {progress[tourId] === "completed" ? (
                  <span
                    className="material-symbols-outlined lt-tour-menu-done"
                    aria-label={t("tutorial.chooseDone")}
                  >
                    check
                  </span>
                ) : null}
              </span>
              <small>{t(`${TOURS[tourId].i18nKey}.summary`)}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
