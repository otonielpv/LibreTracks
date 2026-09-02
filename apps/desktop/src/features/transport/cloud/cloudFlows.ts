import {
  downloadFromCloud,
  getCloudStagingDir,
  type CloudFile,
  type CloudFolder,
} from "../desktopApi";
import { newTransfer, useCloudStore } from "./cloudStore";

/**
 * The local-or-Drive flows behind the ordinary import and export actions.
 *
 * # The cloud is a source, not a separate feature
 *
 * There is no "download" button anywhere. Pressing *Import session* asks where
 * from — this machine or Drive — and Drive simply becomes another place a
 * package can come from, ending in the same import the local path uses. The
 * cloud panel is for managing what is stored (what is there, how much room is
 * left, deleting), never for moving things.
 *
 * # Why these are promises
 *
 * Each step is a question for the user, and awaiting them keeps the flow
 * readable as `ask, then act` instead of callbacks threaded through three
 * components. The store holds the resolver while the modal is up.
 */

/** Ask whether this action targets the local disk or the cloud. */
export function chooseStorage(
  intent: "import" | "export",
  kind: "song" | "session",
): Promise<"local" | "cloud" | null> {
  return new Promise((resolve) => {
    useCloudStore.getState().setPendingChoice({
      intent,
      kind,
      resolve: (choice) => {
        useCloudStore.getState().setPendingChoice(null);
        resolve(choice);
      },
    });
  });
}

/** Ask which package in Drive to use. Resolves null if the user backs out. */
export function pickCloudFile(folder: CloudFolder): Promise<CloudFile | null> {
  const store = useCloudStore.getState();
  // Fired without awaiting: the picker renders its own loading state, and
  // blocking here would leave the user looking at nothing while Drive answers.
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
 * Bring a package down from Drive and hand back the local path it landed on.
 *
 * Staged in a temp directory rather than somewhere the user chose: this file is
 * an implementation detail of an import, not something they keep, and asking
 * for a location would turn one action into two.
 */
async function stageFromCloud(file: CloudFile): Promise<string> {
  const store = useCloudStore.getState();
  const stagingDir = await getCloudStagingDir();
  useCloudStore.setState({ transfer: newTransfer(file.name, "download") });
  try {
    return await downloadFromCloud(file.id, file.name, stagingDir);
  } finally {
    useCloudStore.setState({ transfer: null });
    void store.refreshQuota();
  }
}

/**
 * Full "import from Drive" flow: pick a package, fetch it, import it.
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
  try {
    const localPath = await stageFromCloud(file);
    await runImport(localPath);
    return true;
  } catch (error) {
    useCloudStore.setState({
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
  if (choice === "cloud") {
    await importFromCloud(kind === "song" ? "songs" : "sessions", runCloudImport);
  }
}

/**
 * "Import song" with the local-or-Drive question in front of it.
 *
 * `runImport` is the existing handler: called with no argument it opens the
 * usual file picker, called with a path it imports that package. One function,
 * two sources, so the cloud can never drift from the local behaviour.
 *
 * Shaped as a single call so each entry point in `TransportPanelContent` grows
 * by one line and gains no logic.
 */
export async function importSongWithChoice(
  runImport: (sourcePath?: string) => void,
): Promise<void> {
  await importWithStorageChoice(
    "song",
    () => runImport(),
    async (localPath) => {
      runImport(localPath);
    },
  );
}

/** "Import session" with the local-or-Drive question in front of it. */
export async function importSessionWithChoice(
  runImport: (sourcePath?: string) => void,
): Promise<void> {
  await importWithStorageChoice(
    "session",
    () => runImport(),
    async (localPath) => {
      runImport(localPath);
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

  if (target !== "cloud") {
    await runExport();
    return;
  }

  try {
    const stagingDir = await getCloudStagingDir();
    // Separator by hand rather than a path library: this string only ever goes
    // straight back to Rust, which accepts either on Windows.
    const stagedPath = `${stagingDir}/${fileName}`;
    // Flagged before the export starts so a long zip reads as "preparing" and
    // not as a stalled upload.
    useCloudStore.setState({ transfer: newTransfer(fileName, "preparing") });
    await runExport(stagedPath);
    useCloudStore.setState({ transfer: null });
    await useCloudStore.getState().upload(stagedPath);
  } catch (error) {
    useCloudStore.setState({
      error: error instanceof Error ? error.message : String(error),
    });
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
