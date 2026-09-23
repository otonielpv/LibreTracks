import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  StorageVolume,
  StorageVolumesInfo,
} from "@libretracks/shared/desktopApi";
import {
  getStorageVolumes,
  setSessionStorageVolume,
} from "@libretracks/shared/desktopApi";

import { formatUserFacingError } from "../errors/formatTransportError";

/**
 * "Dónde guardar las sesiones" — Android con tarjeta microSD.
 *
 * Se dibuja **sólo si hay más de un volumen**: en un teléfono sin ranura, y en
 * escritorio e iOS, la lista viene vacía o con una sola entrada y este campo no
 * existe. Elegir no mueve nada: cambia dónde nacen las sesiones NUEVAS, porque
 * mover una son gigabytes y eso no es un cambio de ajuste. Las que ya existen
 * se siguen abriendo porque `state::legacy_project_roots` lista todos los
 * volúmenes, no sólo el actual.
 *
 * Vive en su propio fichero, y no dentro de `SettingsPanel.tsx`, porque ese
 * fichero tiene presupuesto de tamaño (`fileSizeBudget.test.ts`) y la opción
 * por defecto al rebasarlo es extraer. Mismo patrón que `MulticoreAudioField`
 * y `UpdateCheckField`.
 */
export function SessionStorageVolumeField() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<StorageVolumesInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setInfo(await getStorageVolumes());
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(formatUserFacingError(err, t)));
  }, [refresh, t]);

  const handleChange = (path: string) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await setSessionStorageVolume(path === "" ? null : path);
        await refresh();
      } catch (err) {
        setError(formatUserFacingError(err, t));
      } finally {
        setBusy(false);
      }
    })();

  // Nada que elegir: ni un volumen, o sólo uno. No se enseña el control.
  if (!info || info.volumes.length < 2) {
    return null;
  }

  // El índice sólo dice «el 0 es el interno». Lo demás es «extraíble», y eso
  // es tanto una microSD como un pendrive por OTG: el nombre de un extraíble
  // lo pone Android («Tarjeta SD SanDisk», «Unidad USB…»), nunca una etiqueta
  // fija, que es lo que hacía salir los pendrives como «Tarjeta SD».
  const volumeLabel = (volume: StorageVolume) => {
    const name =
      volume.index === 0
        ? t("transport.settingsModal.storageVolumeInternal", {
            defaultValue: "Memoria interna",
          })
        : (volume.label ??
          t("transport.settingsModal.storageVolumeExternal", {
            defaultValue: "Almacenamiento externo",
          }));
    if (volume.freeBytes == null || volume.totalBytes == null) {
      return name;
    }
    return t("transport.settingsModal.storageVolumeWithSpace", {
      defaultValue: "{{name}} — {{free}} libres de {{total}}",
      name,
      free: formatStorageBytes(volume.freeBytes),
      total: formatStorageBytes(volume.totalBytes),
    });
  };

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.storageVolumeTitle", {
          defaultValue: "Dónde guardar las sesiones",
        })}
      </span>
      <select
        value={info.selected ?? ""}
        disabled={busy}
        onChange={(event) => handleChange(event.target.value)}
      >
        {info.volumes.map((volume) => (
          // El primario se guarda como cadena vacía (`null` en los ajustes) y
          // no como su ruta: así un cambio de ruta entre versiones de Android
          // no deja el ajuste apuntando a un sitio que ya no existe.
          <option
            key={volume.path}
            value={volume.index === 0 ? "" : volume.path}
          >
            {volumeLabel(volume)}
          </option>
        ))}
      </select>
      <small>
        {t("transport.settingsModal.storageVolumeHelp", {
          defaultValue:
            "Sólo afecta a las sesiones nuevas: las que ya tienes se siguen abriendo desde donde están. La caché de audio, que es lo que más ocupa, sigue al volumen elegido.",
        })}
      </small>
      {!info.selectedAvailable ? (
        <small
          className="lt-update-check-status lt-update-check-status--error"
          role="status"
        >
          {t("transport.settingsModal.storageVolumeUnavailable", {
            defaultValue:
              "El volumen elegido no está disponible ahora mismo (¿has quitado la tarjeta o el pendrive?). Las sesiones nuevas se están guardando en la memoria interna.",
          })}
        </small>
      ) : null}
      {error ? (
        <small className="lt-update-check-status lt-update-check-status--error">
          {error}
        </small>
      ) : null}
    </label>
  );
}

/**
 * Bytes como los enseña el selector de volumen: una decimal, unidades
 * binarias, y nunca más precisión de la que el número merece.
 */
function formatStorageBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
