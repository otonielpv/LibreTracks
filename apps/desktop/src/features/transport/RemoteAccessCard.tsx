import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";

import type { RemoteServerInfo } from "./desktopApi";

type RemoteAccessCardProps = {
  remoteServerInfo: RemoteServerInfo | null;
};

export function RemoteAccessCard({ remoteServerInfo }: RemoteAccessCardProps) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!remoteServerInfo?.origin) {
      setQrDataUrl(null);
      return;
    }

    void QRCode.toDataURL(remoteServerInfo.origin, {
      margin: 1,
      width: 132,
      color: {
        dark: "#0f1917",
        light: "#ffffff",
      },
    }).then((dataUrl) => {
      if (!cancelled) {
        setQrDataUrl(dataUrl);
      }
    }).catch(() => {
      if (!cancelled) {
        setQrDataUrl(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [remoteServerInfo?.origin]);

  if (!remoteServerInfo) {
    return null;
  }

  const ipUrl = remoteServerInfo.origin;
  const hostnameUrl = remoteServerInfo.localHostnameOrigin ?? `http://${remoteServerInfo.hostname}.local:${remoteServerInfo.port}`;

  return (
    <aside className="lt-remote-card" aria-label={t("remoteAccess.title")}>
      <div className="lt-remote-card-copy">
        <span className="lt-remote-card-eyebrow">{t("remoteAccess.eyebrow")}</span>
        <strong>{t("remoteAccess.title")}</strong>
        <p>{t("remoteAccess.sameNetwork")}</p>

        <div className="lt-remote-link-list">
          <div className="lt-remote-link-row">
            <span>{t("remoteAccess.ipUrl")}</span>
            <code>{ipUrl}</code>
          </div>
          <div className="lt-remote-link-row">
            <span>{t("remoteAccess.hostnameUrl")}</span>
            <code>{hostnameUrl}</code>
          </div>
        </div>
      </div>

      <div className="lt-remote-qr-shell">
        {qrDataUrl ? (
          <img className="lt-remote-qr" src={qrDataUrl} alt={t("remoteAccess.qrAlt")} />
        ) : (
          <div className="lt-remote-qr lt-remote-qr-placeholder" aria-hidden="true" />
        )}
      </div>
    </aside>
  );
}
