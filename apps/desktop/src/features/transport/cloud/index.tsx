import { CloudFlowModals } from "./CloudFlowModals";
import { CloudPanel } from "./CloudPanel";
import { CloudToast } from "./CloudToast";

export { CloudLandingButton } from "./CloudLandingButton";
export {
  beginExportWithChoice,
  exportAskingWhere,
  finishExportWithChoice,
  importSessionWithChoice,
  importSongWithChoice,
} from "./cloudFlows";
export { confirmSessionExport, confirmSongExport } from "./exportWiring";
export { useCloudStore } from "./cloudStore";

/**
 * Every piece of cloud UI that has to exist in the tree, in one element.
 *
 * The panel and the two flow modals are all overlays that render nothing until
 * something asks for them, and they are always mounted together. Grouping them
 * means `TransportPanelContent` carries one line for the whole feature instead
 * of one per surface — which matters, because that file is under a hard line
 * budget and the rule is to extract rather than raise it.
 */
export function CloudSurfaces() {
  return (
    <>
      <CloudPanel />
      <CloudFlowModals />
      <CloudToast />
    </>
  );
}
