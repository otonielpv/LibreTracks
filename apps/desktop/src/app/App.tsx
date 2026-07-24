import { useEffect, useState } from "react";

import { TransportPanel } from "../features/transport/TransportPanel";
import { isTauriApp } from "../features/transport/desktopApi";
import { PerfHud } from "../features/transport/perf/PerfHud";
import { UpdateModal } from "../features/updates/UpdateModal";
import { useUpdateCheck } from "../features/updates/useUpdateCheck";
import { DialogHost } from "../shared/dialog/DialogHost";
import {
  dispatchUiZoomStatus,
  getUiZoom,
  initUiZoom,
  resetUiZoom,
  stepUiZoom,
} from "../shared/uiZoom";

async function isDebugBuild() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("is_debug_build");
}

async function loadAppVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

export function App() {
  const [showPerfHud, setShowPerfHud] = useState(import.meta.env.DEV);
  const [currentVersion, setCurrentVersion] = useState<string>("");

  useEffect(() => {
    if (import.meta.env.DEV || !isTauriApp) {
      return;
    }

    let active = true;
    void isDebugBuild()
      .then((debugBuild) => {
        if (active) {
          (
            window as unknown as { __LT_DEBUG_BUILD?: boolean }
          ).__LT_DEBUG_BUILD = debugBuild;
          setShowPerfHud(debugBuild);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauriApp) return;
    let active = true;
    void loadAppVersion().then((version) => {
      if (active && version) {
        setCurrentVersion(version);
        (window as { __LT_APP_VERSION__?: string }).__LT_APP_VERSION__ = version;
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Interface zoom: apply the persisted scale on start, and wire the standard
  // Cmd/Ctrl +/-/0 shortcuts so small screens (e.g. a 13" MacBook) can shrink
  // the whole UI to fit. Lives here so it works regardless of focus/panel.
  useEffect(() => {
    initUiZoom();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const previousZoom = getUiZoom();
      const showZoomStatus = () => {
        const nextZoom = getUiZoom();
        if (nextZoom !== previousZoom) {
          dispatchUiZoomStatus(nextZoom);
        }
      };
      switch (event.key) {
        case "=":
        case "+":
          event.preventDefault();
          stepUiZoom(1);
          showZoomStatus();
          break;
        case "-":
        case "_":
          event.preventDefault();
          stepUiZoom(-1);
          showZoomStatus();
          break;
        case "0":
          event.preventDefault();
          resetUiZoom();
          showZoomStatus();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // In-app update check runs on both desktop and Android. Each GitHub release
  // now bundles the signed APK alongside the desktop installers under the same
  // version tag, and the download page lists the .apk asset, so the modal's
  // "Download" button lands the phone on a page where the APK is available.
  // Suppress the update-available popup under WebDriver: it would otherwise
  // fire on startup (the freshly built E2E binary can outrank the last known
  // release, or a newer release may exist) and intercept flows like reopening a
  // session. Gated on navigator.webdriver, mirroring the __ltE2E test seam, so a
  // real user session is unaffected.
  const isWebDriver =
    typeof navigator !== "undefined" && navigator.webdriver === true;
  const { release, isModalOpen, dismiss } = useUpdateCheck({
    currentVersion,
    enabled: isTauriApp && !import.meta.env.DEV && !isWebDriver,
  });

  return (
    <main className="lt-app-shell">
      <TransportPanel />
      {showPerfHud ? <PerfHud /> : null}
      {isModalOpen && release ? (
        <UpdateModal
          release={release}
          currentVersion={currentVersion}
          onClose={dismiss}
        />
      ) : null}
      <DialogHost />
    </main>
  );
}
