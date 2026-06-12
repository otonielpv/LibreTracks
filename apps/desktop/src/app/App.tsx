import { useEffect, useState } from "react";

import { TransportPanel } from "../features/transport/TransportPanel";
import { isTauriApp } from "../features/transport/desktopApi";
import { PerfHud } from "../features/transport/perf/PerfHud";
import { UpdateModal } from "../features/updates/UpdateModal";
import { useUpdateCheck } from "../features/updates/useUpdateCheck";
import { DialogHost } from "../shared/dialog/DialogHost";
import { initUiZoom, resetUiZoom, stepUiZoom } from "../shared/uiZoom";

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
      switch (event.key) {
        case "=":
        case "+":
          event.preventDefault();
          stepUiZoom(1);
          break;
        case "-":
        case "_":
          event.preventDefault();
          stepUiZoom(-1);
          break;
        case "0":
          event.preventDefault();
          resetUiZoom();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { release, isModalOpen, dismiss } = useUpdateCheck({
    currentVersion,
    enabled: isTauriApp && !import.meta.env.DEV,
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
