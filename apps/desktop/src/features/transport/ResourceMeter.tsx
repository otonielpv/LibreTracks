import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useSystemResources } from "./hooks/useSystemResources";

/** Format a byte count as a human-readable size (e.g. "1.4 GB"). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  const decimals = value >= 100 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

/** Byte rate per second, e.g. "2.1 MB/s". */
function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Severity bucket for the threshold colouring. Mirrors the green/amber/red
 * pattern used by the dev PerfHud so the whole app reads consistently. Returned
 * as a class suffix rather than an inline colour so the CSS stays Catalina/old
 * Safari compatible (no color-mix / inline rgba juggling).
 */
function severity(percent: number): "ok" | "warn" | "high" {
  if (percent >= 85) return "high";
  if (percent >= 60) return "warn";
  return "ok";
}

/**
 * Always-visible top-bar resource meter (Ableton-style). Shows app CPU, app
 * RAM, and disk throughput at a glance; click to expand a popover with the full
 * process-vs-system breakdown. Purely diagnostic — helps the user (and us
 * during support) tell whether a slowdown is LibreTracks or the whole machine.
 */
export function ResourceMeter() {
  const { t } = useTranslation();
  const snapshot = useSystemResources();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside click / Escape, matching how the rest of the
  // top bar's menus behave.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!snapshot) return null;

  const cpuPercent = Math.max(0, Math.min(100, snapshot.processCpuPercent));
  const ramPercent =
    snapshot.systemMemoryTotalBytes > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (snapshot.processMemoryBytes / snapshot.systemMemoryTotalBytes) *
              100,
          ),
        )
      : 0;
  const diskBytesPerSec =
    snapshot.diskReadBytesPerSec + snapshot.diskWriteBytesPerSec;
  const systemMemoryPercent =
    snapshot.systemMemoryTotalBytes > 0
      ? (snapshot.systemMemoryUsedBytes / snapshot.systemMemoryTotalBytes) * 100
      : 0;
  const audioLoadPercent = Math.max(0, snapshot.audioLoadPercent);

  const ariaSummary = t("resourceMeter.ariaSummary", {
    cpu: cpuPercent.toFixed(0),
    ram: ramPercent.toFixed(0),
    disk: formatBytes(diskBytesPerSec),
  });

  return (
    <div
      className={`lt-resource-meter ${open ? "is-open" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="lt-resource-meter-trigger"
        aria-label={ariaSummary}
        aria-expanded={open}
        title={t("resourceMeter.label")}
        onClick={() => setOpen((prev) => !prev)}
      >
        <ResourceGauge
          label={t("resourceMeter.cpu")}
          percent={cpuPercent}
          value={`${cpuPercent.toFixed(0)}%`}
        />
        <ResourceGauge
          label={t("resourceMeter.ram")}
          percent={ramPercent}
          value={formatBytes(snapshot.processMemoryBytes)}
        />
        <ResourceGauge
          label={t("resourceMeter.disk")}
          // Disk has no natural 0..100 scale; treat sustained throughput as a
          // soft bar (caps visually at ~50 MB/s) just for the fill width.
          percent={Math.min(100, (diskBytesPerSec / (50 * 1024 * 1024)) * 100)}
          value={formatRate(diskBytesPerSec)}
        />
        {snapshot.audioEngineActive ? (
          <ResourceGauge
            label={t("resourceMeter.audio")}
            percent={Math.min(100, audioLoadPercent)}
            value={`${audioLoadPercent.toFixed(0)}%`}
          />
        ) : null}
      </button>

      {open ? (
        <div className="lt-resource-meter-panel" role="dialog">
          <div className="lt-resource-meter-panel-header">
            {t("resourceMeter.panelTitle")}
          </div>
          <dl className="lt-resource-meter-rows">
            <ResourceRow
              label={t("resourceMeter.processCpu")}
              value={`${cpuPercent.toFixed(1)} %`}
              percent={cpuPercent}
            />
            <ResourceRow
              label={t("resourceMeter.systemCpu")}
              value={`${snapshot.systemCpuPercent.toFixed(1)} %`}
              percent={snapshot.systemCpuPercent}
            />
            <ResourceRow
              label={t("resourceMeter.processRam")}
              value={formatBytes(snapshot.processMemoryBytes)}
              percent={ramPercent}
            />
            <ResourceRow
              label={t("resourceMeter.systemRam")}
              value={t("resourceMeter.ofTotal", {
                used: formatBytes(snapshot.systemMemoryUsedBytes),
                total: formatBytes(snapshot.systemMemoryTotalBytes),
              })}
              percent={systemMemoryPercent}
            />
            <ResourceRow
              label={t("resourceMeter.diskRead")}
              value={formatRate(snapshot.diskReadBytesPerSec)}
            />
            <ResourceRow
              label={t("resourceMeter.diskWrite")}
              value={formatRate(snapshot.diskWriteBytesPerSec)}
            />
            <ResourceRow
              label={t("resourceMeter.audioLoad")}
              value={
                snapshot.audioEngineActive
                  ? `${audioLoadPercent.toFixed(1)} %`
                  : t("resourceMeter.audioInactive")
              }
              percent={
                snapshot.audioEngineActive ? audioLoadPercent : undefined
              }
            />
            {snapshot.audioEngineActive ? (
              <ResourceRow
                label={t("resourceMeter.audioUnderruns")}
                value={`${snapshot.audioUnderrunCount}`}
                // Any dropout is bad — flag red as soon as it's nonzero.
                percent={snapshot.audioUnderrunCount > 0 ? 100 : 0}
              />
            ) : null}
          </dl>
          <p className="lt-resource-meter-hint">{t("resourceMeter.hint")}</p>
        </div>
      ) : null}
    </div>
  );
}

type ResourceGaugeProps = {
  label: string;
  percent: number;
  value: string;
};

function ResourceGauge({ label, percent, value }: ResourceGaugeProps) {
  return (
    <span className="lt-resource-gauge" data-severity={severity(percent)}>
      <span className="lt-resource-gauge-label">{label}</span>
      <span className="lt-resource-gauge-bar" aria-hidden="true">
        <span
          className="lt-resource-gauge-fill"
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </span>
      <span className="lt-resource-gauge-value">{value}</span>
    </span>
  );
}

type ResourceRowProps = {
  label: string;
  value: string;
  percent?: number;
};

function ResourceRow({ label, value, percent }: ResourceRowProps) {
  return (
    <div
      className="lt-resource-meter-row"
      data-severity={percent !== undefined ? severity(percent) : undefined}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
