import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { isMobileApp, isTauriApp } from "@libretracks/shared/desktopApi";

import { formatOffset } from "./badgeView";
import {
  acceptRoleChange,
  becomeMain,
  dismissRoleChange,
  followAgain,
  getRedundancyStatus,
  listenToRedundancyStatus,
  rearmPilotTone,
  takeCommand,
  type FingerprintDiff,
} from "./redundancyApi";
import { useRedundancyStore } from "./redundancyStore";
import "./redundancy.css";

/** Follows `redundancy:status` into the store. Mounted once, by the root. */
function useRedundancyEvents() {
  useEffect(() => {
    if (!isTauriApp) return () => {};
    const store = useRedundancyStore.getState();
    let disposed = false;
    let dispose: (() => void) | null = null;
    void listenToRedundancyStatus(store.setStatus)
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {});
    void getRedundancyStatus()
      .then((status) => {
        if (!disposed) store.setStatus(status);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);
}

export function diffText(diff: FingerprintDiff, t: TFunction) {
  switch (diff.kind) {
    case "timingSettingsDiffer":
      return t("redundancy.diff.timingSettingsDiffer", { which: diff.which });
    case "algorithmVersion":
    case "setlistOrder":
      return t(`redundancy.diff.${diff.kind}`);
    default:
      return t(`redundancy.diff.${diff.kind}`, { title: diff.title });
  }
}

function elapsed(since: number | null, now: number) {
  if (since === null) return "";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The big red banner on a backup that lost its main (local controls are
 * already unlocked by then). */
function MainLostBanner() {
  const { t } = useTranslation();
  const since = useRedundancyStore((state) => state.mainLostAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="lt-redundancy-banner is-lost" role="alert">
      <span className="material-symbols-outlined" aria-hidden="true">
        warning
      </span>
      <strong>{t("redundancy.banner.mainLost")}</strong>
      <span className="lt-redundancy-banner-time">
        {t("redundancy.banner.since", { time: elapsed(since, now) })}
      </span>
      <span>{t("redundancy.banner.unlocked")}</span>
      <button type="button" onClick={() => void takeCommand()}>
        {t("redundancy.takeCommand")}
      </button>
    </div>
  );
}

function DivergedDialog() {
  const { t } = useTranslation();
  return (
    <div className="lt-modal-backdrop">
      <div className="lt-redundancy-dialog" role="dialog" aria-modal="true" aria-labelledby="lt-redundancy-diverged-title">
        <h2 id="lt-redundancy-diverged-title">{t("redundancy.diverged.title")}</h2>
        <p>{t("redundancy.diverged.body")}</p>
        <div className="lt-redundancy-dialog-actions">
          <button type="button" className="is-primary" onClick={() => void followAgain()}>
            {t("redundancy.diverged.followAgain")}
          </button>
          <button type="button" onClick={() => void becomeMain()}>
            {t("redundancy.becomeMain")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Planned handover from a following backup: two presses, so a stray tap
 * in the middle of a song switches nothing. */
export function SwitchToThisMachine() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}>
        {t("redundancy.switchHere.button")}
      </button>
    );
  }
  return (
    <span className="lt-redundancy-confirm" role="group" aria-label={t("redundancy.switchHere.button")}>
      <span>{t("redundancy.switchHere.confirm")}</span>
      <button
        type="button"
        className="is-primary"
        onClick={() => {
          setConfirming(false);
          void takeCommand();
        }}
      >
        {t("redundancy.switchHere.yes")}
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        {t("redundancy.switchHere.no")}
      </button>
    </span>
  );
}

function DetailPanel() {
  const { t, i18n } = useTranslation();
  const status = useRedundancyStore((state) => state.status);
  const close = useRedundancyStore((state) => state.closeDetail);
  if (!status) return null;
  const canSwitchHere =
    status.role === "backup" && (status.state === "following" || status.state === "armed");
  const offset = formatOffset(status.offsetMs, i18n.language);
  const canBecomeMain =
    status.role === "backup" && (status.state === "standalone" || status.state === "diverged");
  return (
    <div className="lt-modal-backdrop" onClick={close}>
      <div
        className="lt-redundancy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-redundancy-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="lt-redundancy-detail-title">{t("redundancy.title")}</h2>
        <dl className="lt-redundancy-detail">
          <dt>{t("redundancy.detail.role")}</dt>
          <dd>{t(`redundancy.roles.${status.role}`)}</dd>
          <dt>{t("redundancy.detail.other")}</dt>
          <dd>{status.otherName ?? "–"}</dd>
          <dt>{t("redundancy.detail.offset")}</dt>
          <dd>{offset ? t("redundancy.ms", { value: offset }) : "–"}</dd>
          <dt>{t("redundancy.detail.corrections")}</dt>
          <dd>{status.corrections}</dd>
          <dt>{t("redundancy.detail.pilotTone")}</dt>
          <dd>{status.pilotToneOn ? t("redundancy.on") : t("redundancy.off")}</dd>
          {status.reason ? (
            <>
              <dt>{t("redundancy.detail.reason")}</dt>
              <dd>{status.reason}</dd>
            </>
          ) : null}
        </dl>
        {status.sampleRateDiffers ? (
          <p className="lt-redundancy-warning">{t("redundancy.detail.sampleRateDiffers")}</p>
        ) : null}
        {status.diffs.length > 0 ? (
          <ul className="lt-redundancy-diffs">
            {status.diffs.map((diff, index) => (
              <li key={index}>{diffText(diff, t)}</li>
            ))}
          </ul>
        ) : null}
        <div className="lt-redundancy-dialog-actions">
          {canSwitchHere ? <SwitchToThisMachine /> : null}
          {canBecomeMain ? (
            <button type="button" className="is-primary" onClick={() => void becomeMain()}>
              {t("redundancy.becomeMain")}
            </button>
          ) : null}
          <button type="button" onClick={close}>
            {t("redundancy.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Notice() {
  const notice = useRedundancyStore((state) => state.notice);
  const clear = useRedundancyStore((state) => state.clearNotice);
  useEffect(() => {
    if (!notice) return () => {};
    const timer = window.setTimeout(clear, 2500);
    return () => window.clearTimeout(timer);
  }, [notice, clear]);
  if (!notice) return null;
  return (
    <div className="lt-redundancy-notice" role="status">
      <span className="material-symbols-outlined" aria-hidden="true">
        lock
      </span>
      {notice}
    </div>
  );
}

/**
 * Everything redundancy shows over the app: the event feed, the main-lost
 * banner, the diverged dialog, the role-change offer, the unclean-exit
 * warning, the detail panel and the locked-transport notice. Self-contained:
 * the transport tree only mounts it.
 */
export function RedundancyRoot() {
  useRedundancyEvents();
  const { t } = useTranslation();
  const status = useRedundancyStore((state) => state.status);
  const detailOpen = useRedundancyStore((state) => state.detailOpen);
  if (!FEATURE_FLAGS.redundancy || isMobileApp) return null;
  const backup = status?.role === "backup";
  return (
    <>
      {backup && status?.state === "mainLost" ? <MainLostBanner /> : null}
      {backup && status?.state === "diverged" ? <DivergedDialog /> : null}
      {status?.roleOffer ? (
        <div className="lt-redundancy-banner is-info" role="alert">
          <span>
            {status.handoverBy
              ? t("redundancy.offer.handover", { name: status.handoverBy })
              : t("redundancy.offer.body", { name: status.roleOffer })}
          </span>
          <button type="button" onClick={() => void acceptRoleChange()}>
            {t("redundancy.offer.accept")}
          </button>
          <button type="button" onClick={() => void dismissRoleChange()}>
            {t("redundancy.offer.dismiss")}
          </button>
        </div>
      ) : null}
      {status?.uncleanExitWarning ? (
        <div className="lt-redundancy-banner is-warning" role="alert">
          <span>{t("redundancy.uncleanExit")}</span>
          <button type="button" onClick={() => void rearmPilotTone()}>
            {t("redundancy.rearmPilot")}
          </button>
        </div>
      ) : null}
      {detailOpen ? <DetailPanel /> : null}
      <Notice />
    </>
  );
}
