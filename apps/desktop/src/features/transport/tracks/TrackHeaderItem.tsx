import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { TrackMixControls } from "./TrackMixControls";
import { TrackMeter } from "./TrackMeter";
import type { TrackKind } from "../desktopApi";
import { useTransportStore } from "../store";
import { useTimelineUIStore } from "../uiStore";
import { isMobileApp } from "../desktopApi";

/**
 * Sitio que hay que dejar libre en el borde inferior: ahi flotan la barra de
 * acciones y, debajo, la barra de desplazamiento lateral. El panel de una
 * pista de abajo tapaba la primera justo cuando ibas a borrar la pista.
 *
 * Si `--lt-mobile-float-bottom` sube en styles.css, esto sube con ella.
 */
const BOTTOM_RESERVED_PX = 140;

/**
 * Interactive controls inside the header that own their own pointer gestures:
 * the mute/solo/transpose buttons, the volume and pan faders, and the routing
 * combobox. Neither the track drag nor the track selection may fire when a
 * gesture starts (or ends) on one of these.
 */
const OWN_CONTROL_SELECTOR =
  "button, input, label, textarea, select, .lt-track-toggle-group, .lt-folder-toggle, .lt-track-volume, .lt-track-pan";

function isOwnControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWN_CONTROL_SELECTOR) !== null;
}

type TrackHeaderItemProps = {
  trackId: string;
  trackName: string;
  trackKind: TrackKind;
  hasParent: boolean;
  trackDepth: number;
  trackColor?: string | null;
  childCount: number;
  trackHeight: number;
  panValue: number;
  trackMuted: boolean;
  trackSolo: boolean;
  trackTransposeEnabled: boolean;
  volumeValue: number;
  audioTo: string;
  audioRoutingOptions: Array<{ value: string; label: string }>;
  isCollapsed: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  dropMode: "before" | "after" | "inside-folder" | null;
  isDragging: boolean;
  densityClass: string;
  onSelectTrack: (trackId: string, trackName: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onStartTrackDrag: (
    event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>,
    trackId: string,
  ) => void;
  onToggleFolder: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onToggleTranspose: (trackId: string) => void;
  onVolumeChange: (trackId: string, nextVolume: number) => void;
  onCommitVolume: (trackId: string) => void;
  onPanChange: (trackId: string, nextPan: number) => void;
  onCommitPan: (trackId: string) => void;
  onAudioToChange: (trackId: string, nextAudioTo: string) => void;
};

function TrackHeaderItemComponent({
  trackId,
  trackName,
  trackKind,
  hasParent,
  trackDepth,
  trackColor,
  childCount,
  trackHeight,
  panValue,
  trackMuted,
  trackSolo,
  trackTransposeEnabled,
  volumeValue,
  audioTo,
  audioRoutingOptions,
  isCollapsed,
  isSelected,
  isDropTarget,
  dropMode,
  isDragging,
  densityClass,
  onSelectTrack,
  onOpenContextMenu,
  onStartTrackDrag,
  onToggleFolder,
  onToggleMute,
  onToggleSolo,
  onToggleTranspose,
  onVolumeChange,
  onCommitVolume,
  onPanChange,
  onCommitPan,
  onAudioToChange,
}: TrackHeaderItemProps) {
  const { t } = useTranslation();
  const lastTouchPointerDownAtRef = useRef(0);
  const optimisticMix = useTransportStore((state) => state.optimisticMix[trackId] ?? null);
  // Se lee del store, no por prop: este componente esta memoizado con un
  // comparador explicito, y una prop nueva habria que acordarse de anadirla
  // ahi o la fila no se repintaria al desplegarse.
  const isExpanded = useTimelineUIStore(
    (state) => state.expandedTrackId === trackId,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Abrir hacia ARRIBA cuando no cabe debajo. Se mide en vez de calcularse
  // porque el alto del panel depende de lo que quepa en la fila (el combo de
  // salida envuelve o no), y una constante se quedaria corta en cuanto alguien
  // anada un control.
  const [openUpwards, setOpenUpwards] = useState(false);
  useLayoutEffect(() => {
    if (!isExpanded || !panelRef.current) {
      setOpenUpwards(false);
      return;
    }
    const rect = panelRef.current.getBoundingClientRect();
    setOpenUpwards(rect.bottom > window.innerHeight - BOTTOM_RESERVED_PX);
  }, [isExpanded]);

  // Tocar fuera lo cierra. En CAPTURA sobre window a proposito: la navegacion
  // tactil escucha en captura sobre el area de carriles y hace
  // `stopImmediatePropagation`, asi que un listener que no fuese antes que ella
  // no se enteraria de los toques sobre el timeline —justo donde mas se toca
  // con el panel abierto—.
  useEffect(() => {
    if (!isExpanded) {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          // `[data-lt-panel-portal]`: lo que el panel abre pero cuelga de
          // `document.body` —el desplegable de salida—. Sin esto el panel se
          // cerraba en el `pointerdown` de la opcion, la lista se desmontaba
          // con el, y el click que aplicaba el enrutado nunca llegaba a pasar.
          ".lt-mobile-track-row-panel, .lt-track-header-row, [data-lt-panel-portal]",
        )
      ) {
        return; // dentro del panel, o en la cabecera, que ya alterna sola
      }
      useTimelineUIStore.getState().setExpandedTrackId(null);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [isExpanded]);
  const effectivePanValue = optimisticMix?.pan ?? panValue;
  const effectiveTrackMuted = optimisticMix?.muted ?? trackMuted;
  const effectiveTrackSolo = optimisticMix?.solo ?? trackSolo;
  const effectiveVolumeValue = optimisticMix?.volume ?? volumeValue;
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isOwnControlTarget(event.target)) {
      return;
    }

    if (event.pointerType === "touch") {
      lastTouchPointerDownAtRef.current = Date.now();
    }
    onStartTrackDrag(event, trackId);
  };

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    // iOS emits a compatibility mousedown after the touch finishes. The touch
    // Pointer Event already armed (and may have completed) the drag, so do not
    // create a second stale drag on release.
    if (Date.now() - lastTouchPointerDownAtRef.current < 1000) {
      return;
    }
    if (isOwnControlTarget(event.target)) {
      return;
    }
    onStartTrackDrag(event, trackId);
  };

  // The controls have their own handlers, so a gesture that starts on one must
  // not also select the track: releasing a fader fires a click that bubbles up
  // to the header, which would otherwise collapse a multi-selection down to
  // this one track mid-drag.
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isOwnControlTarget(event.target)) {
      return;
    }

    // Sumando: el toque anade o quita esta pista de la seleccion y no despliega
    // nada. Es la unica forma de juntar varias con un dedo —no hay Ctrl que
    // mantener— y es lo que hace falta para borrarlas de un tiron.
    if (isMobileApp && useTimelineUIStore.getState().trackMultiSelect) {
      useTimelineUIStore.getState().toggleTrackSelection(trackId);
      return;
    }

    onSelectTrack(trackId, trackName, event);
    // En movil la cabecera es fina —solo nombre y estado— asi que el mismo
    // toque que la selecciona despliega sus controles. Dos toques como mucho
    // para llegar a cualquiera de ellos.
    //
    // Salvo reordenando: ahi el dedo esta para mover pistas, y abrir un panel
    // de faders encima es justo lo contrario de lo que se ha pedido.
    if (isMobileApp && !useTimelineUIStore.getState().trackReorderMode) {
      useTimelineUIStore.getState().toggleExpandedTrackId(trackId);
    }
  };

  const metaLabel = trackKind === "folder" ? t("trackHeader.childrenCount", { count: childCount }) : null;
  const routeOptions = hasParent
    ? [
        {
          value: "inherit",
          label: t("trackHeader.inherited", {
            defaultValue: "Inherited (Folder)",
          }),
        },
        ...audioRoutingOptions,
      ]
    : audioRoutingOptions;
  // Mute y solo son los que se pulsan MIENTRAS suena, y comparando entre
  // pistas. En movil se quedan fijos en la cabecera —son el "estado" que la
  // cabecera fina tiene que mostrar— porque pagar un despliegue por cada uno
  // impide justo eso: comparar dos pistas de un tiron. Volumen, pan y salida
  // se ajustan una vez y viven en el panel.
  const muteButton = (
    <button
      type="button"
      className={`lt-track-toggle-mute ${effectiveTrackMuted ? "is-active" : ""}`}
      aria-label={t("trackHeader.mute", { defaultValue: "Silenciar" })}
      onClick={(event) => {
        event.stopPropagation();
        onToggleMute(trackId);
      }}
    >
      M
    </button>
  );
  const soloButton = (
    <button
      type="button"
      className={`lt-track-toggle-solo ${effectiveTrackSolo ? "is-active" : ""}`}
      aria-label={t("trackHeader.solo", { defaultValue: "Solo" })}
      onClick={(event) => {
        event.stopPropagation();
        onToggleSolo(trackId);
      }}
    >
      S
    </button>
  );
  const controlRow = (
          <div className="lt-track-control-row">
            <div className="lt-track-toggle-group">
              {isMobileApp ? null : muteButton}
              {isMobileApp ? null : soloButton}
              <button
                type="button"
                className={`lt-track-toggle-transpose ${trackTransposeEnabled ? "is-active" : ""}`}
                aria-label={trackTransposeEnabled
                  ? t("trackHeader.transposeDisableAria", { name: trackName })
                  : t("trackHeader.transposeEnableAria", { name: trackName })}
                title={trackTransposeEnabled
                  ? t("trackHeader.transposeDisableAria", { name: trackName })
                  : t("trackHeader.transposeEnableAria", { name: trackName })}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleTranspose(trackId);
                }}
              >
                T
              </button>
            </div>
            <TrackMixControls
              trackId={trackId}
              trackName={trackName}
              volumeValue={effectiveVolumeValue}
              panValue={effectivePanValue}
              audioTo={audioTo}
              routeOptions={routeOptions}
              onVolumeChange={onVolumeChange}
              onCommitVolume={onCommitVolume}
              onPanChange={onPanChange}
              onCommitPan={onCommitPan}
              onAudioToChange={onAudioToChange}
            />
          </div>
  );

  const headerStyle = {
    height: trackHeight,
    paddingLeft: 8 + trackDepth * 12,
    ...(trackColor ? { "--lt-track-color": trackColor } : {}),
  } as CSSProperties;

  // El panel desplegado va FUERA de `.lt-track-header`: esa capa tiene
  // `overflow: hidden` y se lo comeria. Colgado de `.lt-track-header-row`
  // -que ya es `position: relative`- cae justo bajo su fila.
  const expandedPanel =
    isMobileApp && isExpanded ? (
      <div
        ref={panelRef}
        className={`lt-mobile-track-row-panel ${openUpwards ? "is-above" : ""}`}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {controlRow}
      </div>
    ) : null;

  return (
    <>
    <div
      className={`lt-track-header ${densityClass} ${isSelected ? "is-selected" : ""} ${effectiveTrackSolo ? "is-solo" : ""} ${trackKind === "folder" ? "is-folder" : ""} ${isDropTarget ? "is-drop-target" : ""} ${isDragging ? "is-dragging" : ""}`}
      style={headerStyle}
      role="button"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onContextMenu={(event) => onOpenContextMenu(event, trackId)}
    >
      <div className="lt-track-header-body">
        <div className="lt-track-header-content">
          <div className="lt-track-header-summary">
            <div className="lt-track-header-main">
              <div className="lt-track-title-row">
                {trackKind === "folder" ? (
                  <button
                    type="button"
                    className="lt-folder-toggle"
                    aria-label={isCollapsed
                      ? t("trackHeader.expand", { name: trackName })
                      : t("trackHeader.collapse", { name: trackName })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFolder(trackId);
                    }}
                  >
                    {isCollapsed ? "+" : "-"}
                  </button>
                ) : null}
                <strong>{trackName}</strong>
                {/* En la MISMA linea que el nombre: colgando debajo estiraban
                    la fila, y con la fila al minimo la cabecera -que recorta lo
                    que sobresale- se llevaba por delante tambien el nombre. */}
                {isMobileApp ? (
                  <span className="lt-track-toggle-group lt-mobile-track-state">
                    {muteButton}
                    {soloButton}
                  </span>
                ) : null}
              </div>
              {metaLabel ? <span className="lt-track-meta">{metaLabel}</span> : null}
            </div>
          </div>

          {isMobileApp ? null : controlRow}
        </div>

        <TrackMeter trackId={trackId} />
      </div>
    </div>
    {expandedPanel}
    </>
  );
}

function areTrackHeaderPropsEqual(previous: TrackHeaderItemProps, next: TrackHeaderItemProps) {
  return (
    previous.trackId === next.trackId &&
    previous.trackName === next.trackName &&
    previous.trackKind === next.trackKind &&
    previous.trackDepth === next.trackDepth &&
    previous.trackColor === next.trackColor &&
    previous.childCount === next.childCount &&
    previous.trackHeight === next.trackHeight &&
    previous.panValue === next.panValue &&
    previous.trackMuted === next.trackMuted &&
    previous.trackSolo === next.trackSolo &&
    previous.trackTransposeEnabled === next.trackTransposeEnabled &&
    previous.volumeValue === next.volumeValue &&
    previous.audioTo === next.audioTo &&
    previous.audioRoutingOptions === next.audioRoutingOptions &&
    previous.isCollapsed === next.isCollapsed &&
    previous.isSelected === next.isSelected &&
    previous.isDropTarget === next.isDropTarget &&
    previous.dropMode === next.dropMode &&
    previous.isDragging === next.isDragging &&
    previous.densityClass === next.densityClass
  );
}

export const TrackHeaderItem = memo(TrackHeaderItemComponent, areTrackHeaderPropsEqual);
