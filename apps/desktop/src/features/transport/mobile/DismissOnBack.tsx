import { useDismissOnBack } from "./backNavigation";

type Props = {
  /** Qué hacer cuando el botón atrás de Android cierre este overlay. */
  close: () => void;
  /**
   * Sólo si el overlay NO se monta y desmonta al abrirse y cerrarse. Cuando
   * sí lo hace —que es lo normal— basta con montar este componente dentro del
   * overlay y dejar esto en su valor por defecto.
   */
  open?: boolean;
};

/**
 * Registra un overlay escrito en línea (un modal que vive dentro del JSX de
 * otro componente, sin componente propio) para que el botón atrás lo cierre.
 *
 * Existe para no meter llamadas a hooks en
 * `features/transport/TransportPanelContent.tsx`: un componente en el árbol de
 * render es una línea de JSX, no estado ni lógica nueva en el monolito. Los
 * overlays que sí tienen componente propio usan {@link useDismissOnBack}
 * directamente.
 */
export function DismissOnBack({ close, open = true }: Props) {
  useDismissOnBack(close, open);
  return null;
}
