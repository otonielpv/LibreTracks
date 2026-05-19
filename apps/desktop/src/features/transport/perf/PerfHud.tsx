import { useEffect, useState } from "react";

import {
  clearRecording,
  downloadRecording,
  isPerfHudEnabled,
  readPerfSnapshot,
  recordingTick,
  setPerfHudEnabled,
  startPerfMetrics,
  stopPerfMetrics,
  type PerfSnapshot,
} from "./perfMetrics";

/**
 * Floating top-left HUD that surfaces the metrics in `perfMetrics`. Toggled
 * via Ctrl+Shift+F or `localStorage.setItem('lt:perf:hud','1')`. Off by
 * default; even when on the HUD only refreshes 4× per second so it can't
 * itself be a frame-budget hog.
 *
 * It is intentionally minimal: no styling system, no theme — inline styles
 * so the component is fully self-contained and copy-pastable into any
 * branch without bringing the project's CSS surface area along.
 */
export function PerfHud() {
  const [enabled, setEnabled] = useState<boolean>(() => isPerfHudEnabled());
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);

  // Keybinding toggle. Lives at the window level so it works regardless of
  // focus inside the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setEnabled((prev) => {
          const next = !prev;
          setPerfHudEnabled(next);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Driving the metrics module + sampling loop.
  useEffect(() => {
    if (!enabled) {
      stopPerfMetrics();
      setSnapshot(null);
      return;
    }
    startPerfMetrics();
    const id = window.setInterval(() => {
      // Two things every 250ms: refresh the visible HUD state, AND drop a
      // sample into the recording buffer so the user can export the whole
      // session afterwards (see Download button below).
      recordingTick();
      setSnapshot(readPerfSnapshot());
    }, 250);
    return () => {
      window.clearInterval(id);
      // Don't auto-stop on unmount: another HUD instance might be elsewhere
      // (e.g. during HMR). stopPerfMetrics is fine to leave to the next
      // toggle-off; the rAF loop is single-instance guarded.
    };
  }, [enabled]);

  if (!enabled || !snapshot) return null;

  const fpsColor =
    snapshot.fps >= 58
      ? "#7ee07e"
      : snapshot.fps >= 45
        ? "#e0c97e"
        : "#e07e7e";
  const worstColor =
    snapshot.worstFrameMs <= 18
      ? "#7ee07e"
      : snapshot.worstFrameMs <= 33
        ? "#e0c97e"
        : "#e07e7e";

  return (
    <div
      role="status"
      aria-label="Performance HUD"
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        zIndex: 99999,
        padding: "8px 10px",
        borderRadius: 6,
        background: "rgba(8, 10, 18, 0.86)",
        border: "1px solid rgba(255, 255, 255, 0.18)",
        font: "11px/1.35 ui-monospace, Menlo, Consolas, monospace",
        color: "#e6e6f0",
        pointerEvents: "none",
        minWidth: 220,
        boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ color: fpsColor, fontWeight: 600 }}>
          {snapshot.fps.toFixed(1)} fps
        </span>
        <span>{snapshot.frameMs.toFixed(1)} ms / frame</span>
      </div>
      <div style={{ color: worstColor, marginTop: 2 }}>
        worst: {snapshot.worstFrameMs.toFixed(1)} ms (last 1s)
      </div>

      <div style={{ marginTop: 6, opacity: 0.82 }}>
        snapshot IPC ema: {snapshot.snapshotIpcEma.toFixed(1)} ms
        {snapshot.snapshotIpcP99 > 0
          ? `  p99: ${snapshot.snapshotIpcP99.toFixed(1)} ms`
          : ""}
      </div>
      <div style={{ opacity: 0.82 }}>
        snapshot→commit: {snapshot.snapshotCommitGapEma.toFixed(1)} ms
      </div>
      <div style={{ marginTop: 4, opacity: 0.82 }}>
        canvas paint: {snapshot.canvasRenderEma.toFixed(1)} ms (ema)
        {snapshot.canvasRenderWorstMs > 0
          ? `  worst: ${snapshot.canvasRenderWorstMs.toFixed(1)} ms`
          : ""}
      </div>

      {snapshot.renderCounts.length > 0 ? (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
          <div style={{ opacity: 0.6, marginBottom: 2 }}>renders</div>
          {snapshot.renderCounts.slice(0, 6).map(([name, count]) => (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ opacity: 0.85 }}>{name}</span>
              <span>{count}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 8,
          paddingTop: 6,
          borderTop: "1px solid rgba(255,255,255,0.12)",
          pointerEvents: "auto",
        }}
      >
        <button
          type="button"
          onClick={async () => {
            // downloadRecording tries clipboard → console → <a download>
            // and tells us which one stuck. Bubble that to the user as a
            // brief HUD message so they aren't left wondering whether the
            // button did anything (the <a download> path silently no-ops
            // inside Tauri's webview).
            const status = await downloadRecording();
            setDownloadStatus(status);
            window.setTimeout(() => setDownloadStatus(null), 3500);
          }}
          style={{
            flex: 1,
            padding: "3px 6px",
            background: "rgba(126, 192, 224, 0.18)",
            color: "#cfe7f5",
            border: "1px solid rgba(126, 192, 224, 0.4)",
            borderRadius: 3,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          copy / log
        </button>
        <button
          type="button"
          onClick={() => clearRecording()}
          style={{
            flex: 1,
            padding: "3px 6px",
            background: "rgba(224, 192, 126, 0.18)",
            color: "#f5e1cf",
            border: "1px solid rgba(224, 192, 126, 0.4)",
            borderRadius: 3,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          clear
        </button>
      </div>

      {downloadStatus ? (
        <div style={{ marginTop: 4, color: "#cfe7f5", opacity: 0.95 }}>
          ✓ {downloadStatus}
        </div>
      ) : null}

      <div style={{ opacity: 0.4, marginTop: 6 }}>
        Ctrl+Shift+F toggle · window.__lt_perf.mark('label')
      </div>
    </div>
  );
}
