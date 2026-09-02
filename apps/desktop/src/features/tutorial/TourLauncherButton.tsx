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

import { useSongStore } from "../transport/songStore";
import { nextUnseenTour, toursForContext } from "./tourModel";
import { currentTourPlatform, useTourStore } from "./tourStore";
import { TOURS } from "./tours";
import { TOUR_TARGETS } from "./tourTargets";

/**
 * Botón TUTORIAL del rail lateral, y su menú de recorridos.
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
  const resetProgress = useTourStore((state) => state.resetProgress);
  const progress = useTourStore((state) => state.progress);
  const hasOpenSession = useSongStore((state) => state.song !== null);
  // El menú vive en el store porque también lo abre la app al cargar una
  // sesión, no sólo este botón.
  const isMenuOpen = useTourStore((state) => state.isMenuOpen);
  const setMenuOpen = useTourStore((state) => state.setMenuOpen);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isMobile = currentTourPlatform() === "mobile";
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const available = toursForContext(hasOpenSession);
  // En el inicio no hay menu aunque haya dos recorridos: se arranca el primero
  // sin ver y al terminarlo la guia encadena el siguiente (ver `endTour`). Con
  // la sesion abierta hay cuatro y elegir si es del usuario.
  const onlyTour = hasOpenSession
    ? available.length === 1
      ? available[0]
      : null
    : (nextUnseenTour(false, progress) ?? available[0]);
  const someTourSeen = available.some(
    (tourId) => progress[tourId] !== undefined,
  );

  const positionDesktopMenu = useCallback(() => {
    if (isMobile) return;
    const anchor = wrapperRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const menu = menuRef.current;
    const width = menu?.offsetWidth || 272;
    const height = menu?.scrollHeight || 280;
    const margin = 12;
    const gap = 6;
    const roomOnRight = window.innerWidth - anchor.right - gap - margin;
    const left =
      roomOnRight >= width
        ? anchor.right + gap
        : Math.max(margin, anchor.left - gap - width);
    const top = Math.min(
      Math.max(margin, anchor.bottom - height),
      Math.max(margin, window.innerHeight - height - margin),
    );
    setMenuPosition({ top, left });
  }, [isMobile]);

  // El menú va por portal para que el overflow del rail no recorte sus tres
  // opciones. En escritorio conserva el anclaje al botón; en móvil CSS lo
  // convierte en una hoja contenida dentro del viewport y las áreas seguras.
  useLayoutEffect(() => {
    if (!isMenuOpen || isMobile) {
      setMenuPosition(null);
      return;
    }
    positionDesktopMenu();
    const frame = requestAnimationFrame(positionDesktopMenu);
    window.addEventListener("resize", positionDesktopMenu);
    window.addEventListener("scroll", positionDesktopMenu, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionDesktopMenu);
      window.removeEventListener("scroll", positionDesktopMenu, true);
    };
  }, [isMenuOpen, isMobile, positionDesktopMenu]);

  // Cerrar al pulsar fuera o con Escape, como los demás menús del rail.
  useEffect(() => {
    if (!isMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !wrapperRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMenuOpen, setMenuOpen]);

  const menuStyle: CSSProperties | undefined = isMobile
    ? undefined
    : menuPosition
      ? { top: `${menuPosition.top}px`, left: `${menuPosition.left}px` }
      : { visibility: "hidden" };

  const menu =
    isMenuOpen && !onlyTour
      ? createPortal(
          <div
            ref={menuRef}
            className="lt-tour-menu"
            role="menu"
            aria-label={t("tutorial.chooseAria")}
            style={menuStyle}
          >
            <span className="lt-tour-menu-title">
              {t("tutorial.chooseTitle")}
            </span>
            {available.map((tourId) => (
              <button
                key={tourId}
                type="button"
                role="menuitem"
                data-tour-choice={tourId}
                onClick={() => {
                  setMenuOpen(false);
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

            {/* Un descarte detiene todas las ofertas automáticas. Esta salida
                permite recuperarlas sin borrar el localStorage a mano. */}
            {someTourSeen ? (
              <button
                type="button"
                role="menuitem"
                className="lt-tour-menu-reset"
                data-tour-choice="reset"
                onClick={() => {
                  resetProgress();
                  setMenuOpen(false);
                }}
              >
                <span className="lt-tour-menu-name">
                  {t("tutorial.resetProgress")}
                </span>
                <small>{t("tutorial.resetProgressHint")}</small>
              </button>
            ) : null}
          </div>,
          document.body,
        )
      : null;

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
          setMenuOpen(!isMenuOpen);
        }}
      >
        <span className="material-symbols-outlined">school</span>
        {t("tutorial.launch")}
      </button>

      {menu}
    </div>
  );
}
