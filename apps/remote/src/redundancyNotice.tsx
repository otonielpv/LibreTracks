/**
 * Redundancy (docs/plans/redundancy step 17): when the main LibreTracks
 * goes away or hands over to its backup, tell the person holding the remote
 * and give them a button to the backup's remote. The page itself comes from
 * the main, so it cannot simply reconnect elsewhere after a reload: the last
 * backup address is also kept in localStorage.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";

/** Lost connection this long (ms) before suggesting the backup. */
export const LOST_NOTICE_AFTER_MS = 3000;
const STORAGE_KEY = "lt-remote-backup-url";

export type RedundancyNotice = { kind: "handover" | "lost"; url: string } | null;

export type NoticeInputs = {
  backupUrl: string | null;
  handover: boolean;
  /** When the socket to the main dropped (ms), null while connected. */
  disconnectedSince: number | null;
  dismissed: boolean;
  now: number;
};

/** Pure: which notice to show, if any. */
export function noticeFor(inputs: NoticeInputs): RedundancyNotice {
  if (inputs.dismissed || !inputs.backupUrl) return null;
  if (inputs.handover) return { kind: "handover", url: inputs.backupUrl };
  if (
    inputs.disconnectedSince !== null &&
    inputs.now - inputs.disconnectedSince >= LOST_NOTICE_AFTER_MS
  ) {
    return { kind: "lost", url: inputs.backupUrl };
  }
  return null;
}

function readStoredUrl(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeUrl(url: string | null) {
  try {
    if (url) window.localStorage.setItem(STORAGE_KEY, url);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or storage blocked: the notice still works while open.
  }
}

type NoticeState = {
  backupUrl: string | null;
  handover: boolean;
  disconnectedSince: number | null;
  dismissed: boolean;
  setInfo: (info: { backupRemoteUrl?: string | null; handover?: boolean }) => void;
  connected: () => void;
  disconnected: (at: number) => void;
  dismiss: () => void;
};

export const useRedundancyNoticeStore = create<NoticeState>()((set, get) => ({
  backupUrl: typeof window === "undefined" ? null : readStoredUrl(),
  handover: false,
  disconnectedSince: null,
  dismissed: false,
  setInfo: (info) => {
    const backupUrl = info.backupRemoteUrl ?? null;
    storeUrl(backupUrl);
    const handover = Boolean(info.handover);
    set({ backupUrl, handover, dismissed: handover ? false : get().dismissed });
  },
  connected: () => set({ disconnectedSince: null, dismissed: false }),
  disconnected: (at) => {
    if (get().disconnectedSince === null) set({ disconnectedSince: at });
  },
  dismiss: () => set({ dismissed: true }),
}));

export function RedundancyNoticeBanner({
  strings,
}: {
  strings: { handover: string; lost: string; goToBackup: string; dismiss: string };
}) {
  const state = useRedundancyNoticeStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.disconnectedSince === null) return () => {};
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [state.disconnectedSince]);
  const notice = noticeFor({ ...state, now });
  if (!notice) return null;
  return (
    <div className="remote-redundancy-notice" role="alert">
      <span>{notice.kind === "handover" ? strings.handover : strings.lost}</span>
      <a className="remote-redundancy-go" href={notice.url}>
        {strings.goToBackup}
      </a>
      <button type="button" onClick={state.dismiss}>
        {strings.dismiss}
      </button>
    </div>
  );
}
