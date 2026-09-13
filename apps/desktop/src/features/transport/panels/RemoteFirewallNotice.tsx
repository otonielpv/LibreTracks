import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  allowRemoteThroughFirewall,
  getRemoteFirewallStatus,
  isTauriApp,
  type RemoteFirewallStatus,
} from "../desktopApi";
import { describeFirewallProfiles } from "../remoteFirewall";

/**
 * Aviso —y arreglo— cuando el cortafuegos de Windows no deja llegar al Remote.
 *
 * El fallo que cubre: Windows enseña su "¿permitir el acceso?" una sola vez por
 * programa, con unas casillas de perfil de red. Quien las marque mal se queda
 * con una regla que, por ejemplo, solo vale en redes públicas, y en el wifi de
 * casa el móvil no conecta — sin que Windows vuelva a preguntar ni la app dé
 * ninguna pista. Ver `platform/windows_firewall.rs`.
 *
 * Solo aparece cuando hay algo que arreglar: en macOS y Linux, y con la regla
 * bien puesta, no renderiza nada. El botón es la única vía que saca el UAC;
 * nada aquí eleva por su cuenta.
 */
export function RemoteFirewallNotice() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteFirewallStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixed, setFixed] = useState(false);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }
    let cancelled = false;
    void getRemoteFirewallStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => {
        // El comando no existe (build viejo) o falló: sin veredicto no se
        // inventa un aviso. El panel queda como estaba.
        if (!cancelled) {
          setStatus(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAllow() {
    setApplying(true);
    setError(null);
    try {
      const next = await allowRemoteThroughFirewall();
      setStatus(next);
      setFixed(next.covered);
      if (!next.covered) {
        // La regla se creó pero sigue sin cubrir: mejor decirlo que enseñar un
        // "listo" que el usuario desmentirá en cuanto lo pruebe.
        setError(t("remoteAccess.firewall.unknown"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(false);
    }
  }

  if (!status || !status.supported) {
    return null;
  }
  if (status.covered && !fixed) {
    return null;
  }

  const active = describeFirewallProfiles(status.activeProfiles, t);
  const allowed = describeFirewallProfiles(status.allowedProfiles, t);

  let message: string;
  if (!status.known) {
    message = t("remoteAccess.firewall.unknown");
  } else if (status.allowedProfiles.length === 0) {
    message = t("remoteAccess.firewall.noRule", { active });
  } else {
    message = t("remoteAccess.firewall.blocked", { active, allowed });
  }

  return (
    <aside className="lt-remote-firewall" aria-live="polite">
      {fixed ? (
        <p className="lt-remote-firewall-done">
          <span className="material-symbols-outlined" aria-hidden="true">
            check_circle
          </span>
          {t("remoteAccess.firewall.done")}
        </p>
      ) : (
        <>
          <strong className="lt-remote-firewall-title">
            <span className="material-symbols-outlined" aria-hidden="true">
              shield
            </span>
            {t("remoteAccess.firewall.title")}
          </strong>
          <p>{message}</p>
          {error ? <p className="lt-remote-firewall-error">{error}</p> : null}
          <button type="button" onClick={() => void handleAllow()} disabled={applying}>
            {applying
              ? t("remoteAccess.firewall.applying")
              : t("remoteAccess.firewall.allow")}
          </button>
          <small>{t("remoteAccess.firewall.allowHint")}</small>
        </>
      )}
    </aside>
  );
}
