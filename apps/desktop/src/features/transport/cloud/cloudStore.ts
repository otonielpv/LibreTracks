import { create } from "zustand";

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
  type CloudQuota,
  type CloudStatus,
} from "../desktopApi";

/**
 * State for moving packages in and out of the user's own Google Drive.
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
  resolve: (choice: "local" | "cloud" | null) => void;
};

export type PendingPick = {
  folder: CloudFolder;
  resolve: (file: CloudFile | null) => void;
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
  /**
   * `preparing` is the local half of an export: writing the .ltpkg/.ltset
   * before a byte goes anywhere. Distinguished because zipping a gigabyte of
   * audio and uploading it are very different waits, and reporting both as
   * "uploading" makes a slow export look like a slow network.
   */
  direction: "upload" | "download" | "preparing";
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
  /** Set while the "which file from Drive" picker is on screen. */
  pendingPick: PendingPick | null;
  /**
   * Where the export in progress is headed.
   *
   * The destination is asked before the mode chooser opens, but only used after
   * it closes, so it has to survive in between. It lives here rather than in
   * `TransportPanelContent` so that file gains no state.
   */
  exportTarget: "local" | "cloud" | null;
  status: CloudStatus | null;
  quota: CloudQuota | null;
  files: Record<CloudFolder, CloudFile[]>;
  /** True only while the browser sign-in is in flight. */
  connecting: boolean;
  loadingFolder: CloudFolder | null;
  transfer: CloudTransfer | null;
  /** True after cancel was pressed and before the backend transfer exits. */
  cancelling: boolean;
  /** Last failure, already translated to a human sentence by the backend. */
  error: string | null;

  openPanel: () => void;
  closePanel: () => void;
  setPendingChoice: (choice: PendingChoice | null) => void;
  setPendingPick: (pick: PendingPick | null) => void;
  setExportTarget: (target: "local" | "cloud" | null) => void;
  refreshStatus: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshQuota: () => Promise<void>;
  refreshFiles: (folder: CloudFolder) => Promise<void>;
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
  status: null,
  quota: null,
  files: { ...EMPTY_FILES },
  connecting: false,
  loadingFolder: null,
  transfer: null,
  cancelling: false,
  error: null,

  openPanel: () => set({ isPanelOpen: true, error: null }),
  closePanel: () => set({ isPanelOpen: false }),
  setPendingChoice: (pendingChoice) => set({ pendingChoice }),
  setPendingPick: (pendingPick) => set({ pendingPick }),
  setExportTarget: (exportTarget) => set({ exportTarget }),

  refreshStatus: async () => {
    try {
      set({ status: await getCloudStatus() });
    } catch (error) {
      // A status probe that fails must not present as "disconnected": the
      // difference between "no account" and "could not ask" changes what the
      // user should do about it.
      set({ error: messageOf(error) });
    }
  },

  connect: async () => {
    set({ connecting: true, error: null });
    try {
      await connectCloud();
      await get().refreshStatus();
      await get().refreshQuota();
    } catch (error) {
      set({ error: messageOf(error) });
    } finally {
      set({ connecting: false });
    }
  },

  disconnect: async () => {
    try {
      await disconnectCloud();
      // Drop everything the account produced, or the manager keeps listing
      // files from an account that is no longer connected.
      set({ quota: null, files: { ...EMPTY_FILES }, error: null });
      await get().refreshStatus();
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshQuota: async () => {
    try {
      set({ quota: await getCloudQuota() });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  refreshFiles: async (folder) => {
    set({ loadingFolder: folder, error: null });
    try {
      const listed = await listCloudFiles(folder);
      set((state) => ({ files: { ...state.files, [folder]: listed } }));
    } catch (error) {
      set({ error: messageOf(error) });
    } finally {
      set({ loadingFolder: null });
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
      const uploaded = await uploadToCloud(localPath);
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
    if (!transfer || transfer.direction === "preparing" || get().cancelling) {
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
      await deleteCloudFile(fileId);
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
      status: null,
      quota: null,
      files: { ...EMPTY_FILES },
      connecting: false,
      loadingFolder: null,
      transfer: null,
      cancelling: false,
      error: null,
    }),
}));
