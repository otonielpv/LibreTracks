import { useTranslation } from "react-i18next";

import { useCloudStore } from "./cloudStore";

/**
 * Entrada "Nube" del menú de acciones de archivo de Android.
 *
 * En móvil la pantalla de inicio desaparece en cuanto se abre una sesión, y con
 * ella el botón Nube. Sin esta entrada el panel quedaba inalcanzable justo
 * cuando más se usa: con el repertorio abierto, para subir lo que acabas de
 * montar o revisar cuánto espacio queda.
 *
 * Vive aquí y no dentro del menú por la misma razón que
 * {@link CloudLandingButton}: el monolito gana una línea en vez de una docena,
 * y tiene un presupuesto de tamaño que se respeta extrayendo, no subiéndolo.
 */
export function CloudMenuItem({ onSelected }: { onSelected: () => void }) {
  const { t } = useTranslation();
  const openPanel = useCloudStore((state) => state.openPanel);

  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelected();
        openPanel();
      }}
    >
      <span className="material-symbols-outlined">cloud</span>
      {t("transport.cloud.landingAction", { defaultValue: "Nube" })}
    </button>
  );
}
