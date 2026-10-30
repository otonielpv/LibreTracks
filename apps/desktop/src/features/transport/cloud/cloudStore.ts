import { create } from "zustand";
import { recordProductEvent } from "../../telemetry/telemetry";

import {
  cancelCloudTransfer,
  connectCloud,
  deleteCloudFile,
  disconnectCloud,
  getCloudQuota,
  getCloudStatus,
  listCloudFiles,
  uploadToCloud,
  type CloudFile,
  type CloudFolder,
  type CloudProviderId,
  type CloudQuota,
  type CloudStatus,
} from "../desktopApi";

/**
 * State for moving packages in and out of the user's own cloud accounts
 * (Google Drive, OneDrive, Dropbox; several may be connected at once).
 *
 * # Why a store and not component state
 *
 * The connection is consulted from several places that never share a parent:
 * the settings panel, the storage manager, and every export/import entry point
 * that offers "local or Drive". A store keeps one answer for all of them and
 * survives a panel being closed mid-transfer, which `useState` would not.
 *
 * Nothing here is added to `TransportPanelContent`, per the repo rule that a
 * new feature brings its own module rather than growing the monolith.
 */

/**
 * A question the UI is waiting on, held as the resolver of a promise.
 *
 * Lets the flows read as straight-line async code (`ask, then act`) instead of
 * a chain of callbacks threaded through three components: the flow awaits, the
 * modal resolves.
 */
export type PendingChoice = {
  intent: "import" | "export";
  kind: "song" | "session";
  resolve: (choice: StorageChoice | null) => void;
};

/**
 * Where an import comes from or an export goes.
 *
 * An export names the account it uploads to. An import only says "cloud": the
 * picker then lists every connected account at once, and the file chosen
 * carries its own provider.
 */
export type StorageChoice = "local" | "cloud" | CloudProviderId;

/** Whether a destination is one of the accounts rather than this device. */
export function isCloudTarget(target: StorageChoice | null): target is CloudProviderId {
  return target !== null && target !== "local" && target !== "cloud";
}

/** The status of one provider, or undefined before the first probe answers. */
export function statusOf(
  statuses: CloudStatus[] | null,
  provider: CloudProviderId,
): CloudStatus | undefined {
  return statuses?.find((status) => status.provider === provider);
}

/** A file in one of the accounts, tagged with the account it lives in. */
export type ProviderFile = CloudFile & {
  provider: CloudProviderId;
  providerName: string;
};

export type PendingPick = {
  folder: CloudFolder;
  resolve: (file: ProviderFile | null) => void;
};

export type CloudTransfer = {
  /** File being moved, for the label. */
  name: string;
  doneBytes: number;
  totalBytes: number;
  /** Smoothed transfer rate, or null until two samples have arrived. */
  bytesPerSecond: number | null;
  /** Seconds left at the current rate, or null while the rate is unknown. */
  etaSeconds: number | null;
  /** Previous sample, kept to derive the rate. Not for display. */
  sampledAtMs: number;
  sampledBytes: number;
  direction: "upload" | "download";
  percent: number;
};

type CloudState = {
  /**
   * Whether the panel is showing.
   *
   * Lives here rather than as `useState` in `TransportPanelContent` on purpose:
   * the repo rule is that a new feature adds no state to that monolith, so it
   * only renders `<CloudPanel />` and anything that wants to open it calls
   * `openPanel()`.
   */
  isPanelOpen: boolean;
  /** Set while the local-or-cloud chooser is on screen. */
  pendingChoice: PendingChoice | null;
  /** Set while the "which file from the cloud" picker is on screen. */
  pendingPick: PendingPick | null;
  /**
   * Where the export in progress is headed.
   *
   * The destination is asked before the mode chooser opens, but only used after
   * it closes, so it has to survive in between. It lives here rather than in
   * `TransportPanelContent` so that file gains no state.
   */
  exportTarget: StorageChoice | null;
  /** Every provider and its state; null until the first probe answers. */
  statuses: CloudStatus[] | null;
  /**
   * The account the panel, the picker and the transfers are working with.
   *
   * One at a time on purpose: `quota` and `files` below belong to it, and a
   * flow sets it from the user's choice before listing or uploading.
   */
  provider: CloudProviderId;
  /** Quota and listings of {@link provider}. */
  quota: CloudQuota | null;
  files: Record<CloudFolder, CloudFile[]>;
  /** The provider whose browser sign-in is in flight, if any. */
  connecting: CloudProviderId | null;
  loadingFolder: CloudFolder | null;
  /**
   * What the import picker shows: one folder of EVERY connected account,
   * merged and tagged. Separate from `files`, which belongs to the panel's
   * working account.
   */
  pickerFiles: ProviderFile[];
  pickerLoading: boolean;
  transfer: CloudTransfer | null;
  /** True after cancel was pressed and before the backend transfer exits. */
  cancelling: boolean;
  /** Last failure, already translated to a human sentence by the backend. */
  error: string | null;

  openPanel: () => void;
  closePanel: () => void;
  setPendingChoice: (choice: PendingChoice | null) => void;
  setPendingPick: (pick: PendingPick | null) => void;
  setExportTarget: (target: StorageChoice | null) => void;
  /** Switch the working account, dropping the previous one's listings. */
  setProvider: (provider: CloudProviderId) => void;
  refreshStatus: () => Promise<void>;
  connect: (provider: CloudProviderId) => Promise<void>;
  disconnect: (provider: CloudProviderId) => Promise<void>;
  refreshQuota: () => Promise<void>;
  refreshFiles: (folder: CloudFolder) => Promise<void>;
  /** Load `folder` from every connected account into `pickerFiles`. */
  refreshPickerFiles: (folder: CloudFolder) => Promise<void>;
  upload: (localPath: string) => Promise<CloudFile | null>;
  remove: (folder: CloudFolder, fileId: string) => Promise<void>;
  setTransferProgress: (doneBytes: number, totalBytes: number, atMs: number) => void;
  cancelTransfer: () => Promise<void>;
  clearError: () => void;
  reset: () => void;
};

/** A transfer at zero, with its rate baseline started. */
export function newTransfer(
  name: string,
  direction: CloudTransfer["direction"],
): CloudTransfer {
  return {
    name,
    direction,
    percent: 0,
    doneBytes: 0,
    totalBytes: 0,
    bytesPerSecond: null,
    etaSeconds: null,
    sampledAtMs: Date.now(),
    sampledBytes: 0,
  };
}

const EMPTY_FILES: Record<CloudFolder, CloudFile[]> = {
  songs: [],
  sessions: [],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isCloudTransferCancellation(error: unknown): boolean {
  return messageOf(error).toLowerCase().includes("transfer was cancelled");
}

export const useCloudStore = create<CloudState>((set, get) => ({
  isPanelOpen: false,
  pendingChoice: null,
  pendingPick: null,
  exportTarget: null,
  statuses: null,
  provider: "google-drive",
  quota: null,
  files: { ...EMPTY_FILES },
  connecting: null,
  loadingFolder: null,
  pickerFiles: [],
  pickerLoading: false,
  transfer: null,
  cancelling: false,
  error: null,

  openPanel: () => set({ isPanelOpen: true, error: null }),
  closePanel: () => set({ isPanelOpen: false }),
  setPendingChoice: (pendingChoice) => set({ pendingChoice }),
  setPendingPick: (pendingPick) => set({ pendingPick }),
  setExportTarget: (exportTarget) => set({ exportTarget }),
  setProvider: (provider) => {
    if (provider === get().provider) {
      return;
    }
    // The previous account's files must not show under the new one's name,
    // not even for the moment the new listing takes.
    set({ provider, quota: null, files: { ...EMPTY_FILES }, error: null });
  },

  refreshStatus: async () => {
    try {
      set({ statuses: await getCloudStatus() });
    } catch (error) {
      // A status probe that fails must not present as "disconnected": the
      // difference between "no account" and "could not ask" changes what the
      // user should do about it.
      set({ error: messageOf(error) });
    }
  },

  connect: async (provider) => {
    set({ connecting: provider, error: null });
    try {
      await connectCloud(provider);
      recordProductEvent("feature_cloud");
      get().setProvider(provider);
      await get().refreshStatus();
      await get().refreshQuota();
    } catch (error) {
      set({ error: messageOf(error) });
    } finally {
      set({ connecting: null });
    }
  },

  disconnect: async (provider) => {
    try {
      await disconnectCloud(provider);
      // Drop everything the account produced, or the manager keeps listing
      // files from an account that is no longer connected. Only when it is the
      // one on screen: the others' state is not loaded anyway.
      if (get().provider === provider) {
        set({ quota: null, files: { ...EMPTY_FILES } });
      }
      set({ error: null });
      await get().refreshStatus();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshQuota: async () => {
    try {
      const provider = get().provider;
      const quota = await getCloudQuota(provider);
      // Dropped if the user switched account while it was in flight.
      if (get().provider === provider) {
        set({ quota });
      }
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshFiles: async (folder) => {
    set({ loadingFolder: folder, error: null });
    try {
      const provider = get().provider;
      const listed = await listCloudFiles(provider, folder);
      if (get().provider === provider) {
        set((state) => ({ files: { ...state.files, [folder]: listed } }));
      }
    } catch (error) {
      set({ error: messageOf(error) });
    } finally {
      set({ loadingFolder: null });
    }
  },

  refreshPickerFiles: async (folder) => {
    set({ pickerFiles: [], pickerLoading: true, error: null });
    try {
      // Re-read the statuses: the picker must not miss an account connected a
      // moment ago, nor list one just disconnected.
      await get().refreshStatus();
      const connected = (get().statuses ?? []).filter((status) => status.connected);
      // One account failing (expired grant, no network to that host) must not
      // hide the others: each is listed on its own and failures are reported.
      const results = await Promise.allSettled(
        connected.map(async (status) =>
          (await listCloudFiles(status.provider, folder)).map(
            (file): ProviderFile => ({
              ...file,
              provider: status.provider,
              providerName: status.name,
            }),
          ),
        ),
      );
      const merged = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      merged.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      set({ pickerFiles: merged, ...(failed ? { error: messageOf(failed.reason) } : {}) });
    } finally {
      set({ pickerLoading: false });
    }
  },

  upload: async (localPath) => {
    const name = localPath.split(/[\\/]/).pop() ?? localPath;
    set({
      transfer: newTransfer(name, "upload"),
      cancelling: false,
      error: null,
    });
    try {
      const uploaded = await uploadToCloud(get().provider, localPath);
      recordProductEvent("feature_cloud");
      // The folder it landed in follows from the extension, exactly as the
      // backend routed it, so the listing refreshes without a second guess.
      const folder: CloudFolder = name.toLowerCase().endsWith(".ltset")
        ? "sessions"
        : "songs";
      await get().refreshFiles(folder);
      await get().refreshQuota();
      return uploaded;
    } catch (error) {
      if (!isCloudTransferCancellation(error)) {
        set({ error: messageOf(error) });
      }
      return null;
    } finally {
      set({ transfer: null, cancelling: false });
    }
  },

  cancelTransfer: async () => {
    const transfer = get().transfer;
    if (!transfer || get().cancelling) {
      return;
    }
    set({ cancelling: true });
    try {
      await cancelCloudTransfer();
    } catch (error) {
      set({ cancelling: false, error: messageOf(error) });
    }
  },

  remove: async (folder, fileId) => {
    try {
      await deleteCloudFile(get().provider, fileId);
      set((state) => ({
        files: {
          ...state.files,
          [folder]: state.files[folder].filter((file) => file.id !== fileId),
        },
      }));
      await get().refreshQuota();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  setTransferProgress: (doneBytes, totalBytes, atMs) => {
    // Dropped when no transfer is in flight: progress events can arrive just
    // after one finishes and would otherwise resurrect the progress bar.
    const transfer = get().transfer;
    if (!transfer) {
      return;
    }

    const elapsedSeconds = (atMs - transfer.sampledAtMs) / 1000;
    const deltaBytes = doneBytes - transfer.sampledBytes;
    let bytesPerSecond = transfer.bytesPerSecond;

    // Samples closer than a quarter second make the instantaneous rate wild
    // (a tiny delta over a tiny interval), so they update the totals but not
    // the rate. Beyond that, smooth: an unsmoothed figure jitters so much it
    // is unreadable, and the chunked upload reports in coarse bursts.
    if (elapsedSeconds >= 0.25 && deltaBytes > 0) {
      const instant = deltaBytes / elapsedSeconds;
      bytesPerSecond =
        bytesPerSecond === null ? instant : bytesPerSecond * 0.7 + instant * 0.3;
    }

    const remaining = Math.max(0, totalBytes - doneBytes);
    set({
      transfer: {
        ...transfer,
        doneBytes,
        totalBytes,
        percent:
          totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0,
        bytesPerSecond,
        etaSeconds:
          bytesPerSecond && bytesPerSecond > 0 ? remaining / bytesPerSecond : null,
        // Only advanced when the rate was recomputed, so a burst of near
        // simultaneous samples still measures against a meaningful baseline.
        sampledAtMs: elapsedSeconds >= 0.25 ? atMs : transfer.sampledAtMs,
        sampledBytes: elapsedSeconds >= 0.25 ? doneBytes : transfer.sampledBytes,
      },
    });
  },

  clearError: () => set({ error: null }),

  reset: () =>
    set({
      isPanelOpen: false,
      pendingChoice: null,
      pendingPick: null,
      exportTarget: null,
      statuses: null,
      provider: "google-drive",
      quota: null,
      files: { ...EMPTY_FILES },
      connecting: null,
      loadingFolder: null,
      pickerFiles: [],
      pickerLoading: false,
      transfer: null,
      cancelling: false,
      error: null,
    }),
}));
