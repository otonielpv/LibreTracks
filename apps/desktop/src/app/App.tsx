import { useEffect, useState } from "react";

import { TransportPanel } from "../features/transport/TransportPanel";
import { isTauriApp } from "../features/transport/desktopApi";
import { PerfHud } from "../features/transport/perf/PerfHud";

async function isDebugBuild() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("is_debug_build");
}

export function App() {
  const [showPerfHud, setShowPerfHud] = useState(import.meta.env.DEV);

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

  return (
    <main className="lt-app-shell">
      <TransportPanel />
      {showPerfHud ? <PerfHud /> : null}
    </main>
  );
}
