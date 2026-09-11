import type { SongView } from "../desktopApi";
import type { ContextMenuAction } from "../types";
import { useTimelineUIStore } from "../uiStore";
import { MarkerPositionEditor } from "../timeline/MarkerPositionEditor";
import { MobileSelectionActionBar } from "./MobileSelectionActionBar";
import type { MultiTrackMixActions } from "../tracks/MultiTrackMixControls";
import type {
  MobileCreationHandlers,
  MobileSelectionMenus,
} from "./selectionActions";

type MobileDawOverlaysProps = {
  song: SongView | null;
  selectedRegionId: string | null;
  workspaceEndSeconds: number;
  menus: MobileSelectionMenus | null;
  creation: MobileCreationHandlers;
  onCommitMarkerPosition: (markerId: string, startSeconds: number) => void;
  onOpenSheet: (title: string, actions: ContextMenuAction[]) => void;
  onClearSelection: () => void;
  mix: MultiTrackMixActions;
  audioRoutingOptions: Array<{ value: string; label: string }>;
};

/**
 * Lo que flota sobre la linea de tiempo en la app movil.
 *
 * Solo en la vista DAW. Compacta es para quien no quiere marcas —anadir audios
 * y tocar— y Directo es para el escenario: en las dos, unas acciones de "crear
 * seccion" flotando sobre la pantalla estorban y no ayudan.
 *
 * La puerta se mira aqui y no en el panel para que el monolito solo tenga que
 * invocar una etiqueta.
 */
export function MobileDawOverlays({
  song,
  selectedRegionId,
  workspaceEndSeconds,
  menus,
  creation,
  onCommitMarkerPosition,
  onOpenSheet,
  onClearSelection,
  mix,
  audioRoutingOptions,
}: MobileDawOverlaysProps) {
  const viewMode = useTimelineUIStore((state) => state.viewMode);
  if (viewMode !== "daw") {
    return null;
  }

  return (
    <>
      <MarkerPositionEditor
        song={song}
        workspaceEndSeconds={workspaceEndSeconds}
        onCommit={onCommitMarkerPosition}
      />
      <MobileSelectionActionBar
        song={song}
        selectedRegionId={selectedRegionId}
        menus={menus}
        creation={creation}
        onOpenSheet={onOpenSheet}
        onClearSelection={onClearSelection}
        mix={mix}
        audioRoutingOptions={audioRoutingOptions}
      />
    </>
  );
}
