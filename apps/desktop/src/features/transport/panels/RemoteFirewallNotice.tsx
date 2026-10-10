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
/**
 * `textKeys`: where the wording comes from. The rule is per program, so the
 * same check and fix serve the network-session host (`networkSession.firewall`),
 * which only needs its own words ("los demás dispositivos" instead of "el
 * móvil"). The profile names stay shared.
 */
export function RemoteFirewallNotice({
  textKeys = "remoteAccess.firewall",
}: { textKeys?: string } = {}) {
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
        setError(t(`${textKeys}.unknown`));
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
    message = t(`${textKeys}.unknown`);
  } else if (status.allowedProfiles.length === 0) {
    message = t(`${textKeys}.noRule`, { active });
  } else {
    message = t(`${textKeys}.blocked`, { active, allowed });
  }

  return (
    <aside className="lt-remote-firewall" aria-live="polite">
      {fixed ? (
        <p className="lt-remote-firewall-done">
          <span className="material-symbols-outlined" aria-hidden="true">
            check_circle
          </span>
          {t(`${textKeys}.done`)}
        </p>
      ) : (
        <>
          <strong className="lt-remote-firewall-title">
            <span className="material-symbols-outlined" aria-hidden="true">
              shield
            </span>
            {t(`${textKeys}.title`)}
          </strong>
          <p>{message}</p>
          {error ? <p className="lt-remote-firewall-error">{error}</p> : null}
          <button type="button" onClick={() => void handleAllow()} disabled={applying}>
            {applying
              ? t(`${textKeys}.applying`)
              : t(`${textKeys}.allow`)}
          </button>
          <small>{t(`${textKeys}.allowHint`)}</small>
        </>
      )}
    </aside>
  );
}
