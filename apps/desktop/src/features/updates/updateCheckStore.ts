import { useSyncExternalStore } from "react";

import {
  fetchLatestRelease,
  setLastCheck,
  shouldNotify,
  type ReleaseInfo,
} from "../../shared/updateCheck";

export type UpdateCheckSnapshot = {
  release: ReleaseInfo | null;
  error: string | null;
  isChecking: boolean;
  isModalOpen: boolean;
  hasCheckedOnce: boolean;
};

const listeners = new Set<() => void>();
let snapshot: UpdateCheckSnapshot = {
  release: null,
  error: null,
  isChecking: false,
  isModalOpen: false,
  hasCheckedOnce: false,
};
let inflight: AbortController | null = null;
let currentVersion = "";

function setSnapshot(next: Partial<UpdateCheckSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

export function getUpdateCheckSnapshot(): UpdateCheckSnapshot {
  return snapshot;
}

export function setCurrentVersion(version: string): void {
  currentVersion = version;
}

export function getCurrentVersion(): string {
  return currentVersion;
}

export function openUpdateModal(): void {
  if (snapshot.release) setSnapshot({ isModalOpen: true });
}

export function closeUpdateModal(): void {
  setSnapshot({ isModalOpen: false });
}

export async function runUpdateCheck(
  options: { force?: boolean } = {},
): Promise<void> {
  if (!currentVersion) return;
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  setSnapshot({ isChecking: true, error: null });
  try {
    const latest = await fetchLatestRelease({ signal: controller.signal });
    setLastCheck();
    if (!latest) {
      setSnapshot({ release: null, hasCheckedOnce: true });
      return;
    }
    const shouldOpen = shouldNotify({
      currentVersion,
      release: latest,
      bypassSnooze: options.force,
    });
    setSnapshot({
      release: latest,
      isModalOpen: shouldOpen,
      hasCheckedOnce: true,
    });
  } catch (caught) {
    if (controller.signal.aborted) return;
    setSnapshot({
      error: caught instanceof Error ? caught.message : "Unknown error",
      hasCheckedOnce: true,
    });
  } finally {
    if (!controller.signal.aborted) setSnapshot({ isChecking: false });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdateCheckStore(): UpdateCheckSnapshot {
  return useSyncExternalStore(subscribe, getUpdateCheckSnapshot, getUpdateCheckSnapshot);
}
