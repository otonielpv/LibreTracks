import i18n from "../../../shared/i18n";
import { recordProductEvent } from "../../telemetry/telemetry";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import {
  discardStagedPackage,
  downloadFromCloud,
  getCloudStagingDir,
  isMobileApp,
  type CloudFile,
  type CloudFolder,
  type CloudProviderId,
} from "../desktopApi";
import { formatBytes } from "../video/VideoExportOption";
import { connectionType, shouldConfirmCloudDownload } from "../video/videoImportQuestion";
import {
  isCloudTarget,
  isCloudTransferCancellation,
  newTransfer,
  useCloudStore,
  type StorageChoice,
} from "./cloudStore";

/**
 * The local-or-cloud flows behind the ordinary import and export actions.
 *
 * # The cloud is a source, not a separate feature
 *
 * There is no "download" button anywhere. Pressing *Import session* asks where
 * from — this machine, Drive, OneDrive or Dropbox — and the account simply
 * becomes another place a package can come from, ending in the same import the
 * local path uses. The cloud panel is for managing what is stored (what is
 * there, how much room is left, deleting), never for moving things.
 *
 * # Why these are promises
 *
 * Each step is a question for the user, and awaiting them keeps the flow
 * readable as `ask, then act` instead of callbacks threaded through three
 * components. The store holds the resolver while the modal is up.
 */

/**
 * Ask whether this action targets the local disk or one of the accounts.
 *
 * Choosing an account also makes it the store's working provider, so the
 * picker, the download and the upload that follow all talk to it.
 */
export function chooseStorage(
  intent: "import" | "export",
  kind: "song" | "session",
): Promise<StorageChoice | null> {
  return new Promise((resolve) => {
    useCloudStore.getState().setPendingChoice({
      intent,
      kind,
      resolve: (choice) => {
        useCloudStore.getState().setPendingChoice(null);
        if (choice && choice !== "local") {
          useCloudStore.getState().setProvider(choice);
        }
        resolve(choice);
      },
    });
  });
}

/** Ask which package in the working account to use. Null if the user backs out. */
export function pickCloudFile(folder: CloudFolder): Promise<CloudFile | null> {
  const store = useCloudStore.getState();
  // Fired without awaiting: the picker renders its own loading state, and
  // blocking here would leave the user looking at nothing while the provider
  // answers.
  void store.refreshFiles(folder);
  return new Promise((resolve) => {
    store.setPendingPick({
      folder,
      resolve: (file) => {
        useCloudStore.getState().setPendingPick(null);
        resolve(file);
      },
    });
  });
}

/**
 * Bring a package down from the cloud and hand back the local path it landed on.
 *
 * Staged in a temp directory rather than somewhere the user chose: this file is
 * an implementation detail of an import, not something they keep, and asking
 * for a location would turn one action into two.
 */
async function stageFromCloud(file: CloudFile): Promise<string> {
  const store = useCloudStore.getState();
  const stagingDir = await getCloudStagingDir();
  useCloudStore.setState({
    transfer: newTransfer(file.name, "download"),
    cancelling: false,
  });
  try {
    const path = await downloadFromCloud(store.provider, file.id, file.name, stagingDir);
    recordProductEvent("feature_cloud");
    return path;
  } finally {
    useCloudStore.setState({ transfer: null, cancelling: false });
    void store.refreshQuota();
  }
}

/**
 * Full "import from the cloud" flow: pick a package, fetch it, import it.
 *
 * `runImport` is the SAME import the local path uses — the caller passes the
 * existing handler and it receives an ordinary local path. That is what keeps
 * the cloud from becoming a second import implementation that drifts from the
 * first.
 *
 * Returns false when the user backed out at any point, so a caller can tell
 * "cancelled" from "done".
 */
export async function importFromCloud(
  folder: CloudFolder,
  runImport: (localPath: string) => Promise<void>,
): Promise<boolean> {
  const file = await pickCloudFile(folder);
  if (!file) {
    return false;
  }
  // A phone on mobile data asks before pulling a big set (with its videos)
  // down (plan video-mobile, paso 08 §4).
  if (
    isMobileApp &&
    shouldConfirmCloudDownload(file.sizeBytes, connectionType()) &&
    !(await confirmDialog(
      i18n.t("transport.video.cloudCellular", { size: formatBytes(file.sizeBytes, i18n.language) }),
    ))
  ) {
    return false;
  }
  let localPath: string | null = null;
  try {
    localPath = await stageFromCloud(file);
    await runImport(localPath);
    return true;
  } catch (error) {
    if (!isCloudTransferCancellation(error)) {
      useCloudStore.setState({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    // The import unpacks the whole package before it resolves, so the staged
    // copy is dead weight from here on. It used to be left behind: a 10-song
    // set stayed in the cache at full size next to the session it became.
    if (localPath) {
      void discardStagedPackage(localPath).catch(() => {});
    }
  }
}

/**
 * Wrap an existing local import so it first asks where to import from.
 *
 * Built as a wrapper rather than an edit to the handlers themselves so the
 * entry points change by one line each and `TransportPanelContent` gains no
 * logic — the repo rule for anything new.
 */
export async function importWithStorageChoice(
  kind: "song" | "session",
  runLocalImport: () => Promise<void> | void,
  runCloudImport: (localPath: string) => Promise<void>,
): Promise<void> {
  const choice = await chooseStorage("import", kind);
  if (choice === "local") {
    await runLocalImport();
    return;
  }
  if (choice) {
    await importFromCloud(kind === "song" ? "songs" : "sessions", runCloudImport);
  }
}

/**
 * "Import song" with the local-or-cloud question in front of it.
 *
 * `runImport` is the existing handler: called with no argument it opens the
 * usual file picker, called with a path it imports that package. One function,
 * two sources, so the cloud can never drift from the local behaviour.
 *
 * Shaped as a single call so each entry point in `TransportPanelContent` grows
 * by one line and gains no logic.
 */
export async function importSongWithChoice(
  runImport: (sourcePath?: string) => Promise<void> | void,
): Promise<void> {
  await importWithStorageChoice(
    "song",
    () => runImport(),
    async (localPath) => {
      // Awaited: the staged package is deleted as soon as this resolves.
      await runImport(localPath);
    },
  );
}

/** "Import session" with the local-or-cloud question in front of it. */
export async function importSessionWithChoice(
  runImport: (sourcePath?: string) => Promise<void> | void,
): Promise<void> {
  await importWithStorageChoice(
    "session",
    () => runImport(),
    async (localPath) => {
      // Awaited: the staged package is deleted as soon as this resolves.
      await runImport(localPath);
    },
  );
}

/**
 * Ask where an export is going, before the mode chooser opens.
 *
 * The two questions are deliberately in this order: *where* changes what the
 * mode costs. An Optimized set is several times larger than the original, which
 * is a detail on a local disk and a very long upload over a network.
 *
 * `openModeChooser` runs unless the user backs out entirely.
 */
export async function beginExportWithChoice(
  kind: "song" | "session",
  openModeChooser: () => void,
): Promise<void> {
  const choice = await chooseStorage("export", kind);
  if (!choice) {
    return;
  }
  useCloudStore.getState().setExportTarget(choice);
  openModeChooser();
}

/**
 * Finish an export once the mode is known, sending it wherever
 * {@link beginExportWithChoice} was told.
 *
 * `runExport` is the existing handler: with a path it writes there, without one
 * it opens the usual save dialog. The cloud branch writes to the staging
 * directory and uploads that, so the export itself is the same code and the
 * same progress indicator in both cases.
 */
export async function finishExportWithChoice(
  fileName: string,
  runExport: (writePath?: string) => Promise<void> | void,
): Promise<void> {
  const store = useCloudStore.getState();
  const target = store.exportTarget;
  store.setExportTarget(null);

  if (!isCloudTarget(target)) {
    await runExport();
    return;
  }
  uploadTargetIs(target);

  try {
    const stagingDir = await getCloudStagingDir();
    // Separator by hand rather than a path library: this string only ever goes
    // straight back to Rust, which accepts either on Windows.
    const stagedPath = `${stagingDir}/${fileName}`;
    try {
      // No indicator of our own for the export half: it already raises the
      // app's own "Exportando sesion... %", and two overlays describing the
      // same wait is worse than one -- especially when ours could offer
      // neither a cancel button nor a rate. Ours takes over for the upload,
      // which is the half nothing else reports.
      await runExport(stagedPath);
      await useCloudStore.getState().upload(stagedPath);
    } finally {
      // In a finally, not after the upload: a cancelled or failed transfer left
      // its package behind, and these are hundreds of megabytes on a phone that
      // has little room to spare.
      void discardStagedPackage(stagedPath).catch(() => {});
    }
  } catch (error) {
    if (!isCloudTransferCancellation(error)) {
      useCloudStore.setState({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Export that asks *where* after the mode is already chosen.
 *
 * Used for a single song, where {@link beginExportWithChoice}'s "ask first"
 * order buys little: a `.ltpkg` is one song, so the mode barely changes what the
 * upload costs, and the trigger lives inside a cloud-agnostic handlers factory
 * that should not learn about the cloud just to reorder two questions.
 */
export async function exportAskingWhere(
  kind: "song" | "session",
  fileName: string,
  runExport: (writePath?: string) => Promise<void> | void,
): Promise<void> {
  const choice = await chooseStorage("export", kind);
  if (!choice) {
    return;
  }
  useCloudStore.getState().setExportTarget(choice);
  await finishExportWithChoice(fileName, runExport);
}

/**
 * Forget where an export was headed, because it is not happening.
 *
 * `beginExportWithChoice` records the destination and `finishExportWithChoice`
 * spends it, so cancelling the mode chooser in between used to leave it set:
 * the NEXT export then read a stale "cloud" and uploaded without ever asking.
 * Every path that closes a mode chooser without exporting must call this.
 */
export function cancelExportChoice(): void {
  useCloudStore.getState().setExportTarget(null);
}

/**
 * Point the store at the account an export was meant for.
 *
 * Normally already true, since choosing set it. But the destination is held
 * across the mode chooser, and the user can open the cloud panel and switch
 * accounts in between; the export must still land where they first said.
 */
function uploadTargetIs(provider: CloudProviderId): void {
  useCloudStore.getState().setProvider(provider);
}
