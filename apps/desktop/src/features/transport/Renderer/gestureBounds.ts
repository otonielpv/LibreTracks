/**
 * Dónde tiene que estar un dedo para contar como parte del gesto de dos dedos.
 *
 * El área de pistas NO se puede usar tal cual. Su elemento crece con el número
 * de pistas —el desplazamiento vertical lo hace un ancestro, no él— así que su
 * rectángulo se sale de la pantalla por arriba y por abajo: un dedo apoyado en
 * la barra de transporte cae dentro de ese rectángulo aunque no esté ni cerca
 * del timeline, y contarlo hacía que la cámara pegara un salto. Lo que se ve es
 * la parte que cabe en el visor que desplaza, así que el área es la
 * intersección de los dos.
 */
export function intersectVisibleBounds(
  element: HTMLElement | null | undefined,
  viewport: HTMLElement | null | undefined,
): DOMRect | null {
  if (!element) {
    return null;
  }
  const bounds = element.getBoundingClientRect();
  if (!viewport) {
    return bounds;
  }
  const visible = viewport.getBoundingClientRect();
  const left = Math.max(bounds.left, visible.left);
  const right = Math.min(bounds.right, visible.right);
  const top = Math.max(bounds.top, visible.top);
  const bottom = Math.min(bounds.bottom, visible.bottom);
  if (right <= left || bottom <= top) {
    return null;
  }
  return new DOMRect(left, top, right - left, bottom - top);
}
